const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const Aedes = require('aedes');
const mqtt = require('mqtt');

const SparkplugRegistry = require('../services/sparkplugRegistry');
const SparkplugDecoder = require('../services/sparkplugDecoder');
const SparkplugPublisher = require('../services/sparkplugPublisher');

test('registry builds Group → Edge Node → Device topology from topics', () => {
  const r = new SparkplugRegistry();
  r.update('spBv1.0/Plant1/NBIRTH/EdgeA', { metrics: [{ name: 'bdSeq' }] }, 1000);
  r.update('spBv1.0/Plant1/DBIRTH/EdgeA/Pump7', { metrics: [{ name: 'Temperature' }, { name: 'RPM' }] }, 1001);

  const t = r.toJSON();
  assert.strictEqual(t.summary.groups, 1);
  assert.strictEqual(t.summary.edgeNodes, 1);
  assert.strictEqual(t.summary.devices, 1);

  const edge = t.groups[0].edgeNodes[0];
  assert.strictEqual(edge.id, 'EdgeA');
  assert.ok(edge.online, 'edge online after NBIRTH');
  assert.deepStrictEqual(edge.metrics, ['bdSeq']);

  const dev = edge.devices[0];
  assert.strictEqual(dev.id, 'Pump7');
  assert.ok(dev.online, 'device online after DBIRTH');
  assert.deepStrictEqual(dev.metrics.sort(), ['RPM', 'Temperature']);
});

test('NDEATH / DDEATH mark endpoints offline', () => {
  const r = new SparkplugRegistry();
  r.update('spBv1.0/G/NBIRTH/E', null, 1);
  r.update('spBv1.0/G/DBIRTH/E/D', null, 2);
  r.update('spBv1.0/G/DDEATH/E/D', null, 3);
  r.update('spBv1.0/G/NDEATH/E', null, 4);

  const edge = r.toJSON().groups[0].edgeNodes[0];
  assert.strictEqual(edge.online, false);
  assert.strictEqual(edge.devices[0].online, false);
});

test('metric names accumulate across BIRTH and DATA', () => {
  const r = new SparkplugRegistry();
  r.update('spBv1.0/G/DBIRTH/E/D', { metrics: [{ name: 'a' }] }, 1);
  r.update('spBv1.0/G/DDATA/E/D', { metrics: [{ name: 'b' }] }, 2);
  const dev = r.toJSON().groups[0].edgeNodes[0].devices[0];
  assert.deepStrictEqual(dev.metrics.sort(), ['a', 'b']);
  assert.strictEqual(dev.msgCount, 2);
});

test('alias-only DATA metrics resolve to names learned from BIRTH', () => {
  // The standard Sparkplug bandwidth optimization: BIRTH sends {name, alias},
  // DATA sends {alias} only. Before the fix these DATA metrics decoded with an
  // empty name and were lost (registry recorded nothing; flatten collapsed them
  // into the ''-key).
  const r = new SparkplugRegistry();
  r.update('spBv1.0/G/NBIRTH/E', { metrics: [{ name: 'Temp', alias: 3 }, { name: 'RPM', alias: 4 }] }, 1);
  r.update('spBv1.0/G/NDATA/E', { metrics: [{ alias: 3, value: 99 }] }, 2);
  const edge = r.toJSON().groups[0].edgeNodes[0];
  assert.ok(edge.metrics.includes('Temp'), 'alias 3 on DATA must record as "Temp"');

  // resolveMetricNames stamps the name onto the object the DataOps tap sees.
  const metrics = [{ alias: 4, value: 1500 }];
  r.resolveMetricNames('spBv1.0/G/NDATA/E', metrics);
  assert.strictEqual(metrics[0].name, 'RPM');
  assert.strictEqual(metrics[0].nameResolved, true);
});

test('non-Sparkplug topics are ignored', () => {
  const r = new SparkplugRegistry();
  r.update('factory/line1/temp', { metrics: [{ name: 'x' }] }, 1);
  assert.ok(r.isEmpty());
});

test('NDEATH cascades offline to all devices under the edge node', () => {
  const r = new SparkplugRegistry();
  r.update('spBv1.0/G/NBIRTH/E', null, 1);
  r.update('spBv1.0/G/DBIRTH/E/D1', null, 2);
  r.update('spBv1.0/G/DBIRTH/E/D2', null, 3);
  r.update('spBv1.0/G/NDEATH/E', null, 4);

  const edge = r.toJSON().groups[0].edgeNodes[0];
  assert.strictEqual(edge.online, false);
  for (const d of edge.devices) {
    assert.strictEqual(d.online, false, `device ${d.id} must be offline after edge NDEATH`);
    assert.strictEqual(d.lastDeath, 4);
  }
});

// ---- host application STATE ---------------------------------------------------

test('parseSparkplugTopic recognizes STATE host topics and rejects malformed ones', () => {
  const info = SparkplugDecoder.parseSparkplugTopic('spBv1.0/STATE/scada_primary');
  assert.strictEqual(info.namespace, 'spBv1.0');
  assert.strictEqual(info.messageType, 'STATE');
  assert.strictEqual(info.hostId, 'scada_primary');
  assert.strictEqual(info.groupId, null);
  assert.strictEqual(info.edgeNodeId, null);
  assert.strictEqual(info.deviceId, null);

  // Host id is exactly one segment — extra/missing segments are not STATE topics.
  assert.strictEqual(SparkplugDecoder.parseSparkplugTopic('spBv1.0/STATE/host/extra'), null);
  assert.strictEqual(SparkplugDecoder.parseSparkplugTopic('spBv1.0/STATE'), null);
  assert.strictEqual(SparkplugDecoder.parseSparkplugTopic('spBv1.0/STATE/'), null);

  // Regular edge-node topics still parse as before.
  const edge = SparkplugDecoder.parseSparkplugTopic('spBv1.0/G/NBIRTH/E');
  assert.strictEqual(edge.messageType, 'NBIRTH');
  assert.strictEqual(edge.groupId, 'G');
  assert.strictEqual(edge.edgeNodeId, 'E');
});

test('registry folds Sparkplug 3.0 JSON STATE with events only on transitions', () => {
  const r = new SparkplugRegistry();
  r.update('spBv1.0/STATE/scada', null, 10, { online: true, timestamp: 111 });
  // Retained STATE replays to every new subscriber — a duplicate must not re-emit.
  r.update('spBv1.0/STATE/scada', null, 20, { online: true, timestamp: 111 });
  r.update('spBv1.0/STATE/scada', null, 30, { online: false, timestamp: 222 });

  const host = r.toJSON().hosts[0];
  assert.strictEqual(host.id, 'scada');
  assert.strictEqual(host.online, false);
  assert.strictEqual(host.timestamp, 222);
  assert.strictEqual(host.lastSeen, 30);
  assert.strictEqual(host.msgCount, 3);

  const hostEvents = r.events.filter((e) => e.type.startsWith('host-'));
  assert.deepStrictEqual(
    hostEvents.map((e) => e.type),
    ['host-online', 'host-offline'],
    'exactly one event per transition'
  );
});

test('registry handles legacy 2.x text STATE payloads', () => {
  const r = new SparkplugRegistry();
  r.update('spBv1.0/STATE/legacy', null, 1, 'ONLINE');
  assert.strictEqual(r.toJSON().hosts[0].online, true);
  r.update('spBv1.0/STATE/legacy', null, 2, 'OFFLINE');
  assert.strictEqual(r.toJSON().hosts[0].online, false);
  assert.strictEqual(r.events.filter((e) => e.type.startsWith('host-')).length, 2);
});

test('unknown STATE payload shapes mark the host seen but leave state unchanged', () => {
  const r = new SparkplugRegistry();
  r.update('spBv1.0/STATE/h1', null, 1, 'ONLINE');
  r.update('spBv1.0/STATE/h1', null, 2, { weird: 'shape' });
  const host = r.toJSON().hosts[0];
  assert.strictEqual(host.online, true, 'garbage must not flip state');
  assert.strictEqual(host.msgCount, 2);
  assert.strictEqual(host.lastSeen, 2);
  assert.strictEqual(r.events.filter((e) => e.type.startsWith('host-')).length, 1);
});

test('snapshot includes hosts and counts them in the summary', () => {
  const r = new SparkplugRegistry();
  r.update('spBv1.0/G/NBIRTH/E', null, 1);
  r.update('spBv1.0/STATE/scada', null, 2, { online: true, timestamp: 2 });
  const t = r.toJSON();
  assert.strictEqual(t.hosts.length, 1);
  assert.strictEqual(t.summary.hosts, 1);
  assert.strictEqual(t.summary.edgeNodes, 1);
  assert.strictEqual(r.isEmpty(), false);

  const hostsOnly = new SparkplugRegistry();
  hostsOnly.update('spBv1.0/STATE/scada', null, 1, 'ONLINE');
  assert.strictEqual(hostsOnly.isEmpty(), false, 'a host-only registry is not empty');
});

// Host publishing against a real in-process broker (same aedes pattern as
// test/integration.test.js — no fakes between the publisher and MQTT).

async function startBroker() {
  const AedesClass = Aedes.Aedes || Aedes;
  const aedes = AedesClass.createBroker ? await AedesClass.createBroker() : new AedesClass();
  const server = net.createServer(aedes.handle);
  await new Promise((resolve) => server.listen(0, resolve));
  return {
    port: server.address().port,
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

test('publisher host session publishes retained STATE birth and clean offline on stop', async () => {
  const broker = await startBroker();
  const profiles = { brokers: () => [{ config: { id: 'bk', host: '127.0.0.1', port: broker.port } }] };
  const publisher = new SparkplugPublisher({ profiles });

  const witness = mqtt.connect(`mqtt://127.0.0.1:${broker.port}`, { clientId: 'state-witness' });
  const frames = [];
  witness.on('message', (topic, payload, packet) => {
    frames.push({ topic, body: JSON.parse(payload.toString()), retain: packet.retain });
  });
  await new Promise((resolve) => witness.on('connect', resolve));
  await new Promise((resolve) => witness.subscribe('spBv1.0/STATE/#', { qos: 1 }, resolve));

  publisher.startHost({ brokerId: 'bk', hostId: 'manifold_host' });
  assert.ok(await until(() => frames.some((f) => f.body.online === true)), 'online STATE must arrive');
  const birth = frames.find((f) => f.body.online === true);
  assert.strictEqual(birth.topic, 'spBv1.0/STATE/manifold_host');
  assert.ok(Number.isFinite(birth.body.timestamp), 'STATE carries a ms timestamp');

  const status = publisher.getStatus();
  assert.ok(status.hosts['bk manifold_host'], 'getStatus exposes the host session');
  assert.strictEqual(status.hosts['bk manifold_host'].online, true);
  assert.strictEqual(status.hosts['bk manifold_host'].hostId, 'manifold_host');

  // Retained: a late subscriber replays the current STATE.
  const late = mqtt.connect(`mqtt://127.0.0.1:${broker.port}`, { clientId: 'late-witness' });
  const lateFrames = [];
  late.on('message', (topic, payload, packet) => lateFrames.push({ body: JSON.parse(payload.toString()), retain: packet.retain }));
  await new Promise((resolve) => late.on('connect', resolve));
  await new Promise((resolve) => late.subscribe('spBv1.0/STATE/manifold_host', { qos: 1 }, resolve));
  assert.ok(await until(() => lateFrames.some((f) => f.retain && f.body.online === true)), 'retained STATE replays');

  // Clean stop publishes retained offline (not the will) and drops the session.
  await publisher.stopHost('bk', 'manifold_host');
  assert.ok(await until(() => frames.some((f) => f.body.online === false)), 'offline STATE on stop');
  assert.deepStrictEqual(publisher.getStatus().hosts, {}, 'stopped host session leaves status');

  witness.end(true);
  late.end(true);
  await broker.close();
});

test('abrupt host death fires the broker-side retained will (online: false)', async () => {
  const broker = await startBroker();
  const profiles = { brokers: () => [{ config: { id: 'bk', host: '127.0.0.1', port: broker.port } }] };
  const publisher = new SparkplugPublisher({ profiles });

  const witness = mqtt.connect(`mqtt://127.0.0.1:${broker.port}`, { clientId: 'will-witness' });
  const frames = [];
  witness.on('message', (topic, payload) => frames.push(JSON.parse(payload.toString())));
  await new Promise((resolve) => witness.on('connect', resolve));
  await new Promise((resolve) => witness.subscribe('spBv1.0/STATE/#', { qos: 1 }, resolve));

  const h = publisher.startHost({ brokerId: 'bk', hostId: 'fragile' });
  assert.ok(await until(() => frames.some((f) => f.online === true)), 'online STATE first');

  h.client.stream.destroy(); // simulate a crash — no clean offline publish
  assert.ok(await until(() => frames.some((f) => f.online === false)), 'will must announce the death');

  await publisher.stop();
  witness.end(true);
  await broker.close();
});
