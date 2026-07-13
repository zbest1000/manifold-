const { test } = require('node:test');
const assert = require('node:assert');

const MqttManager = require('../services/mqttManager');
const historians = require('../services/historians');

/**
 * Integration against REAL third-party services — EMQX and InfluxDB running as
 * CI service containers (see .github/workflows/ci.yml). These exist because
 * fake-based tests only verify our own assumptions: this layer fails if our
 * client options, line protocol, or auth handling are wrong against the
 * actual products.
 *
 * Gated on INTEGRATION=1 so the suite stays runnable on a laptop without
 * docker; in CI the integration job sets the env and the URLs.
 */

const ENABLED = process.env.INTEGRATION === '1';
const EMQX_HOST = process.env.INTEGRATION_EMQX_HOST || '127.0.0.1';
const EMQX_PORT = Number(process.env.INTEGRATION_EMQX_PORT || 1883);
const INFLUX_URL = process.env.INTEGRATION_INFLUX_URL || 'http://127.0.0.1:8086';
const INFLUX_TOKEN = process.env.INTEGRATION_INFLUX_TOKEN || 'manifold-ci-token';
const INFLUX_ORG = process.env.INTEGRATION_INFLUX_ORG || 'manifold';
const INFLUX_BUCKET = process.env.INTEGRATION_INFLUX_BUCKET || 'ci';

const until = async (fn, ms = 15000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fn();
};

test('EMQX: manager connects, auto-subscribes, and ingests real retained traffic', { skip: !ENABLED }, async () => {
  const manager = new MqttManager({ emit() {} });
  manager.connectToBroker({ id: 'emqx', host: EMQX_HOST, port: EMQX_PORT, name: 'ci-emqx' });
  assert.ok(await until(() => manager.getConnection('emqx')?.status === 'connected'), 'must connect to EMQX');

  await manager.publish('emqx', 'ci/plant/line1/temp', { v: 21.5 }, { retain: true });
  await manager.publish('emqx', 'ci/plant/line1/press', '3.1', { qos: 1 });

  assert.ok(
    await until(() => manager.stores.get('emqx')?.topicCount() >= 2),
    'published topics must round-trip through the broker into the store'
  );

  // The wildcard-resolution engine against real EMQX-delivered topics.
  const resolved = manager.resolveSubscriptions('emqx', ['ci/plant/+/temp']);
  assert.strictEqual(resolved.results[0].matchCount, 1);
  assert.strictEqual(resolved.results[0].sample[0].topic, 'ci/plant/line1/temp');

  manager.shutdown();
});

test('InfluxDB: line-protocol writes land and can be queried back via Flux', { skip: !ENABLED }, async () => {
  const conn = { type: 'influxdb', url: INFLUX_URL, org: INFLUX_ORG, bucket: INFLUX_BUCKET, token: INFLUX_TOKEN, measurement: 'ci_test' };
  const tag = `ci/run/${Date.now()}`;
  await historians.writePoints(conn, [
    { tag, ts: Date.now() - 1000, value: 41 },
    { tag, ts: Date.now(), value: 42 }
  ]);

  const flux = `from(bucket:"${INFLUX_BUCKET}") |> range(start:-5m) |> filter(fn:(r)=> r._measurement=="ci_test" and r.topic=="${tag}")`;
  const found = await until(async () => {
    const res = await fetch(`${INFLUX_URL}/api/v2/query?org=${encodeURIComponent(INFLUX_ORG)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.flux', Accept: 'application/csv', Authorization: `Token ${INFLUX_TOKEN}` },
      body: flux
    });
    const csv = await res.text();
    return csv.includes('42') && csv.includes('ci_test');
  });
  assert.ok(found, 'written points must be queryable from the real InfluxDB');
});
