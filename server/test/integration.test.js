const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const Aedes = require('aedes');
const mqtt = require('mqtt');

const MqttManager = require('../services/mqttManager');
const { PipelineEngine } = require('../services/pipelineEngine');
const SparkplugPublisher = require('../services/sparkplugPublisher');
const SparkplugDecoder = require('../services/sparkplugDecoder');

// Real-broker integration: an in-process aedes broker, the real manager, the
// real engines — no fakes between Manifold and MQTT. This is the test layer
// the fake-based suites can't provide: it fails if our client options,
// subscription setup, publish path, or Sparkplug lifecycle are wrong against
// an actual broker, not against our own assumptions.

function fakeProfiles(data = {}) {
  return {
    listIn: (c) => Object.values(data[c] || {}),
    getIn: (c, id) => (data[c] || {})[id] || null,
    brokers: () => data._brokers || []
  };
}

async function startBroker() {
  // aedes ≥0.51 exports { Aedes } with a static async createBroker()
  const AedesClass = Aedes.Aedes || Aedes;
  const aedes = AedesClass.createBroker ? await AedesClass.createBroker() : new AedesClass();
  const server = net.createServer(aedes.handle);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return {
    port,
    close: async () => {
      await new Promise((r) => aedes.close(r));
      await new Promise((r) => server.close(r));
    }
  };
}

const until = async (fn, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
};

test('end-to-end: manager ingests from a real broker and a pipeline republishes into the UNS', async () => {
  const broker = await startBroker();
  const manager = new MqttManager({ emit() {} });
  const profiles = fakeProfiles({
    pipelines: {
      r1: {
        id: 'r1',
        enabled: true,
        source: { brokerId: 'bk', filter: 'raw/#' },
        transforms: [{ type: 'repath', to: 'uns/{2-}' }, { type: 'envelope' }],
        target: { type: 'mqtt', brokerId: 'bk', retain: false }
      }
    }
  });
  const engine = new PipelineEngine({ mqttManager: manager, profiles, outbox: null });
  engine.start();

  manager.connectToBroker({ id: 'bk', host: '127.0.0.1', port: broker.port, name: 'itest' });
  assert.ok(await until(() => manager.getConnection('bk')?.status === 'connected'), 'manager must connect');

  // Independent witness: a plain mqtt client watching the UNS output.
  const witness = mqtt.connect(`mqtt://127.0.0.1:${broker.port}`, { clientId: 'witness' });
  const seen = [];
  witness.on('message', (topic, payload) => seen.push({ topic, payload: payload.toString() }));
  await new Promise((resolve) => witness.on('connect', resolve));
  await new Promise((resolve) => witness.subscribe('uns/#', resolve));

  const producer = mqtt.connect(`mqtt://127.0.0.1:${broker.port}`, { clientId: 'producer' });
  await new Promise((resolve) => producer.on('connect', resolve));
  producer.publish('raw/line1/temp', '21.5');

  assert.ok(await until(() => seen.length >= 1), 'pipeline output must reach the broker');
  assert.strictEqual(seen[0].topic, 'uns/line1/temp');
  const body = JSON.parse(seen[0].payload);
  assert.strictEqual(body.v, 21.5);
  assert.strictEqual(body.q, 192);

  const m = engine.getMetrics().r1;
  assert.ok(m.matched >= 1 && m.published >= 1 && m.errors === 0);

  engine.stop();
  witness.end(true);
  producer.end(true);
  manager.shutdown();
  await broker.close();
});

test('end-to-end: Sparkplug publisher emits a spec-shaped NBIRTH → DBIRTH → DDATA lifecycle', async () => {
  const broker = await startBroker();
  const profiles = fakeProfiles({
    _brokers: [{ config: { id: 'bk', host: '127.0.0.1', port: broker.port } }]
  });
  const publisher = new SparkplugPublisher({ profiles });
  const decoder = new SparkplugDecoder();

  const witness = mqtt.connect(`mqtt://127.0.0.1:${broker.port}`, { clientId: 'sp-witness' });
  const frames = [];
  witness.on('message', (topic, payload) => {
    try {
      frames.push({ topic, payload: decoder.decode(payload) });
    } catch {
      frames.push({ topic, payload: null });
    }
  });
  await new Promise((resolve) => witness.on('connect', resolve));
  await new Promise((resolve) => witness.subscribe('spBv1.0/#', resolve));

  publisher.updateDevice({ brokerId: 'bk', group: 'Plant', edge: 'Manifold', device: 'Line1', metrics: [{ name: 'temp', value: 20 }] });
  assert.ok(await until(() => frames.some((f) => f.topic.includes('DBIRTH'))), 'DBIRTH must arrive');
  // Same metric set again → DDATA, not another birth.
  publisher.updateDevice({ brokerId: 'bk', group: 'Plant', edge: 'Manifold', device: 'Line1', metrics: [{ name: 'temp', value: 21 }] });
  assert.ok(await until(() => frames.some((f) => f.topic.includes('DDATA'))), 'DDATA must follow');

  const topics = frames.map((f) => f.topic);
  const nbirthIdx = topics.indexOf('spBv1.0/Plant/NBIRTH/Manifold');
  const dbirthIdx = topics.indexOf('spBv1.0/Plant/DBIRTH/Manifold/Line1');
  const ddataIdx = topics.indexOf('spBv1.0/Plant/DDATA/Manifold/Line1');
  assert.ok(nbirthIdx >= 0 && dbirthIdx > nbirthIdx && ddataIdx > dbirthIdx, `lifecycle order wrong: ${topics.join(', ')}`);

  // NBIRTH carries bdSeq and seq 0; seq increments across node messages.
  const nbirth = frames[nbirthIdx].payload;
  assert.strictEqual(Number(nbirth.seq), 0);
  assert.ok(nbirth.metrics.some((m) => m.name === 'bdSeq'));
  assert.strictEqual(Number(frames[dbirthIdx].payload.seq), 1);
  assert.strictEqual(Number(frames[ddataIdx].payload.seq), 2);
  const ddata = frames[ddataIdx].payload;
  assert.strictEqual(ddata.metrics.find((m) => m.name === 'temp').value, 21);

  // Clean stop publishes DDEATH + NDEATH (not just the broker-side will).
  await publisher.stop();
  assert.ok(await until(() => frames.some((f) => f.topic === 'spBv1.0/Plant/NDEATH/Manifold')), 'NDEATH on stop');
  assert.ok(frames.some((f) => f.topic === 'spBv1.0/Plant/DDEATH/Manifold/Line1'), 'DDEATH on stop');

  witness.end(true);
  await broker.close();
});
