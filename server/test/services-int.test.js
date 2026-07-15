const { test } = require('node:test');
const assert = require('node:assert');

const MqttManager = require('../services/mqttManager');
const historians = require('../services/historians');

/**
 * Integration against REAL third-party services — EMQX, InfluxDB, TimescaleDB,
 * and Timebase running as CI service containers (see .github/workflows/ci.yml).
 * These exist because fake-based tests only verify our own assumptions: this
 * layer fails if our client options, line protocol, or auth handling are wrong
 * against the actual products.
 *
 * Gated on INTEGRATION=1 so the suite stays runnable on a laptop without
 * docker; in CI the integration job sets the env and the URLs.
 *
 * Every test carries an explicit timeout and does its cleanup in finally:
 * against real services a hung connection otherwise keeps the event loop
 * alive and the whole CI job spins until the 6-hour kill.
 */

const ENABLED = process.env.INTEGRATION === '1';
const OPTS = (extra = {}) => ({ skip: !ENABLED, timeout: 90_000, ...extra });
const EMQX_HOST = process.env.INTEGRATION_EMQX_HOST || '127.0.0.1';
const EMQX_PORT = Number(process.env.INTEGRATION_EMQX_PORT || 1883);
const EMQX_WS_PORT = Number(process.env.INTEGRATION_EMQX_WS_PORT || 8083);
const INFLUX_URL = process.env.INTEGRATION_INFLUX_URL || 'http://127.0.0.1:8086';
const INFLUX_TOKEN = process.env.INTEGRATION_INFLUX_TOKEN || 'manifold-ci-token';
const INFLUX_ORG = process.env.INTEGRATION_INFLUX_ORG || 'manifold';
const INFLUX_BUCKET = process.env.INTEGRATION_INFLUX_BUCKET || 'ci';
const TSDB_HOST = process.env.INTEGRATION_TSDB_HOST || '127.0.0.1';
const TSDB_PORT = Number(process.env.INTEGRATION_TSDB_PORT || 5432);
const TIMEBASE_URL = process.env.INTEGRATION_TIMEBASE_URL || 'http://127.0.0.1:4511';

const until = async (fn, ms = 15000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fn();
};

test('EMQX: manager connects, auto-subscribes, and ingests real retained traffic', OPTS(), async () => {
  const manager = new MqttManager({ emit() {} });
  try {
    manager.connectToBroker({ id: 'emqx', host: EMQX_HOST, port: EMQX_PORT, name: 'ci-emqx' });
    assert.ok(await until(() => manager.getConnection('emqx')?.status === 'connected'), 'must connect to EMQX');

    // Both retained: stock EMQX refuses '#' at QoS 1 (SUBACK 0x80) and the
    // manager falls back to QoS 0 — retained messages are delivered whenever
    // that (re)subscription lands, so the test doesn't race the SUBACK round.
    await manager.publish('emqx', 'ci/plant/line1/temp', { v: 21.5 }, { retain: true });
    await manager.publish('emqx', 'ci/plant/line1/press', '3.1', { qos: 1, retain: true });

    assert.ok(
      await until(() => manager.stores.get('emqx')?.topicCount() >= 2),
      'published topics must round-trip through the broker into the store'
    );

    // The wildcard-resolution engine against real EMQX-delivered topics.
    const resolved = manager.resolveSubscriptions('emqx', ['ci/plant/+/temp']);
    assert.strictEqual(resolved.results[0].matchCount, 1);
    assert.strictEqual(resolved.results[0].sample[0].topic, 'ci/plant/line1/temp');
  } finally {
    manager.shutdown();
  }
});

test('EMQX: MQTT 5 over WebSocket round-trips user properties', OPTS(), async () => {
  // The unit tests only prove we hand mqtt.js the right URL/options; this
  // proves a real broker accepts ws + protocolVersion 5 and echoes the
  // per-message properties back through the intake into the store.
  const manager = new MqttManager({ emit() {} });
  try {
    manager.connectToBroker({
      id: 'emqx-ws5',
      host: EMQX_HOST,
      port: EMQX_WS_PORT,
      protocol: 'ws',
      wsPath: '/mqtt',
      mqttVersion: 5,
      name: 'ci-emqx-ws5'
    });
    assert.ok(
      await until(() => manager.getConnection('emqx-ws5')?.status === 'connected'),
      'must connect to EMQX over ws with MQTT 5'
    );

    await manager.publish('emqx-ws5', 'ci/ws5/props', { v: 1 }, {
      retain: true,
      properties: { userProperties: { run: 'ci', unit: 'line1' }, contentType: 'application/json' }
    });

    const surfaced = await until(() => {
      const { topics } = manager.getTopics('emqx-ws5');
      const t = topics.find((x) => x.topic === 'ci/ws5/props');
      return t?.properties?.userProperties?.run === 'ci' && t?.properties?.contentType === 'application/json';
    });
    assert.ok(surfaced, 'MQTT 5 user properties must survive the broker round-trip into the topic store');
  } finally {
    manager.shutdown();
  }
});

test('InfluxDB: line-protocol writes land and can be queried back via Flux', OPTS(), async () => {
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

  // The Trends read-back path (queryTags + querySeries) against the same
  // instance — the unit tests only prove our Flux/CSV handling against
  // fixtures; this proves it against real InfluxDB output.
  const tagsListed = await until(async () => {
    const tags = await historians.queryTags(conn, { search: tag, limit: 100 }).catch(() => []);
    return tags.includes(tag);
  });
  assert.ok(tagsListed, 'queryTags must list the written topic');

  const seriesBack = await until(async () => {
    const out = await historians
      .querySeries(conn, { tags: [tag], start: Date.now() - 300_000, end: Date.now() + 60_000, maxPoints: 500 })
      .catch(() => null);
    const values = out?.series?.[0]?.points.map((p) => p[1]) || [];
    return values.includes(41) && values.includes(42);
  });
  assert.ok(seriesBack, 'querySeries must return the written values from real InfluxDB');
});

test('TimescaleDB: batch inserts land in a real hypertable and query back', OPTS(), async () => {
  const conn = {
    type: 'timescaledb',
    host: TSDB_HOST,
    port: TSDB_PORT,
    database: 'manifold',
    user: 'manifold',
    password: 'ci-password',
    table: 'ci_samples'
  };
  const tag = `ci/run/${Date.now()}`;
  const { Pool } = require('pg');
  const pool = new Pool({
    host: TSDB_HOST,
    port: TSDB_PORT,
    database: 'manifold',
    user: 'manifold',
    password: 'ci-password',
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true
  });
  try {
    await historians.writePoints(conn, [
      { tag, ts: Date.now() - 1000, value: 41, quality: 192 },
      { tag, ts: Date.now(), value: 42, quality: 192 }
    ]);

    const res = await pool.query('SELECT value, quality FROM ci_samples WHERE topic = $1 ORDER BY ts', [tag]);
    assert.strictEqual(res.rows.length, 2);
    assert.strictEqual(Number(res.rows[1].value), 42);
    assert.strictEqual(Number(res.rows[1].quality), 192);
  } finally {
    await pool.end().catch(() => {});
    await historians.closePools();
  }
});

test('Timebase: TVQ writes hit the real REST API and read back from the dataset', OPTS(), async (t) => {
  // Unlike the other services, Timebase is probed at runtime: local
  // INTEGRATION=1 runs without the timebase/historian container must still
  // pass, so an unreachable API skips instead of failing.
  const alive = await fetch(`${TIMEBASE_URL}/api/datasets`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!alive) {
    t.skip(`timebase not reachable at ${TIMEBASE_URL}`);
    return;
  }

  // Fresh dataset per run — also proves datasets auto-create on first write
  // (Manifold never pre-creates them).
  const dataset = `ci-run-${Date.now()}`;
  const tag = `ci/run/${Date.now()}`;
  const base = Date.now() - 2000;
  const conn = { type: 'timebase', url: TIMEBASE_URL, dataset };

  const out = await historians.writePoints(conn, [
    { tag, ts: base, value: 41, quality: 192 },
    { tag, ts: base + 1000, value: 42, quality: 192 }
  ]);
  assert.strictEqual(out.written, 2);

  // Read-back via the documented GET:
  //   /api/datasets/{dataset}/data?tagname={tag}&relativeStart=-1h
  // NOTE: tag paths keep literal '/' in the tagname query parameter (the API
  // matches on the raw path), so the tag is NOT encodeURIComponent-ed here.
  // Response shape: { s, e, tl: [{ t: { n, t }, d: [{ t, v, q }] }] }.
  const readUrl = `${TIMEBASE_URL}/api/datasets/${encodeURIComponent(dataset)}/data?tagname=${tag}&relativeStart=-1h`;
  const found = await until(async () => {
    const res = await fetch(readUrl);
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    const series = (data?.tl || []).find((s) => s?.t?.n === tag);
    if (!series || !Array.isArray(series.d)) return false;
    const values = series.d.map((p) => Number(p.v));
    return values.includes(41) && values.includes(42);
  });
  assert.ok(found, 'written TVQs must be queryable back from the real Timebase');

  // Our own querySeries against the same instance — proves the start/end
  // query parameters are honored by the real API, not just relativeStart:
  // an in-window query must return both values, and a window that ends
  // BEFORE the writes must return nothing (if the server ignored unknown
  // range params it would fall back to latest-point and this would leak).
  const inWindow = await historians.querySeries(conn, {
    tags: [tag],
    start: base - 60_000,
    end: base + 60_000,
    maxPoints: 100
  });
  const values = inWindow.series[0].points.map((p) => p[1]);
  assert.ok(values.includes(41) && values.includes(42), `querySeries must return both TVQs, got ${JSON.stringify(values)}`);

  const beforeWrites = await historians.querySeries(conn, {
    tags: [tag],
    start: base - 120_000,
    end: base - 60_000,
    maxPoints: 100
  });
  assert.strictEqual(beforeWrites.series[0].points.length, 0, 'a window before the writes must be empty');
});
