const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const TopicStore = require('../services/topicStore');
const TopicTrie = require('../services/topicTrie');
const ProfileStore = require('../services/profileStore');
const { PipelineEngine } = require('../services/pipelineEngine');
const MqttManager = require('../services/mqttManager');

// Performance floor + restart survival. The perf thresholds are deliberately
// generous (CI runners are slow and shared) — they exist to catch order-of-
// magnitude regressions on the hot path, not to benchmark.

test('perf smoke: 200k ingests + trie build + wildcard resolve stay inside the floor', () => {
  const store = new TopicStore();
  const payload = Buffer.from('{"v":21.5}');
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200_000; i++) {
    store.ingest(`plant/area${i % 20}/line${i % 50}/dev${i % 400}/m${i % 4}`, payload, 0, false);
  }
  const ingestMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const trie = new TopicTrie();
  const t1 = process.hrtime.bigint();
  for (let slot = 0; slot < store.n; slot++) trie.insert(store.topicAt(slot), slot);
  const trieMs = Number(process.hrtime.bigint() - t1) / 1e6;

  const t2 = process.hrtime.bigint();
  const r = trie.resolve('plant/+/line1/#', { sampleLimit: 50 });
  const resolveMs = Number(process.hrtime.bigint() - t2) / 1e6;

  assert.ok(r.matchCount > 0);
  assert.ok(ingestMs < 5000, `ingest of 200k took ${ingestMs.toFixed(0)}ms (floor 5000ms)`);
  assert.ok(trieMs < 5000, `trie build took ${trieMs.toFixed(0)}ms (floor 5000ms)`);
  assert.ok(resolveMs < 200, `wildcard resolve took ${resolveMs.toFixed(1)}ms (floor 200ms)`);
});

test('pipeline dispatch floor: 50k tapped messages against 20 compiled routes', () => {
  const m = new MqttManager({ emit() {} });
  m.publish = async () => {};
  const routes = {};
  for (let i = 0; i < 20; i++) {
    routes[`r${i}`] = {
      id: `r${i}`,
      enabled: true,
      source: { brokerId: 'b1', filter: `plant/area${i}/#` },
      transforms: [{ type: 'repath', to: 'uns/{2-}' }],
      target: { type: 'mqtt', brokerId: 'b2' }
    };
  }
  const profiles = { rev: 1, listIn: () => Object.values(routes), getIn: () => null };
  const eng = new PipelineEngine({ mqttManager: m, profiles, outbox: null });
  eng.start();
  const msg = { brokerId: 'b1', topic: 'plant/area7/line1/temp', payload: 1, qos: 0, retain: false, timestamp: new Date().toISOString() };
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 50_000; i++) m.emit('message', msg);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(eng.getMetrics().r7.matched, 50_000);
  assert.ok(ms < 3000, `50k dispatches took ${ms.toFixed(0)}ms (floor 3000ms)`);
  eng.stop();
  m.shutdown();
});

test('restart survival: DataOps config persists and a fresh engine compiles it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-restart-'));
  const p1 = new ProfileStore(dir);
  p1.upsertIn('pipelines', 'route-1', {
    name: 'survivor',
    enabled: true,
    source: { brokerId: 'b1', filter: 'raw/#' },
    transforms: [{ type: 'envelope' }],
    // different target broker — same-broker + unchanged topic would (rightly)
    // trip the self-loop guard
    target: { type: 'mqtt', brokerId: 'b2' }
  });
  p1.upsertIn('historians', 'h-1', { type: 'influxdb', url: 'http://i:8086', org: 'o', bucket: 'b', token: 'secret' });

  // "Restart": a brand-new store over the same dir must see everything…
  const p2 = new ProfileStore(dir);
  assert.strictEqual(p2.getIn('pipelines', 'route-1').name, 'survivor');
  assert.strictEqual(p2.getIn('historians', 'h-1').token, 'secret');

  // …and a fresh engine must dispatch on the restored route immediately.
  const m = new MqttManager({ emit() {} });
  const published = [];
  m.publish = async (brokerId, topic, payload) => {
    published.push({ topic, payload });
  };
  const eng = new PipelineEngine({ mqttManager: m, profiles: p2, outbox: null });
  eng.start();
  m.emit('message', { brokerId: 'b1', topic: 'raw/x', payload: 5, qos: 0, retain: false, timestamp: new Date().toISOString() });
  return new Promise((resolve) => {
    setImmediate(() => {
      assert.strictEqual(published.length, 1);
      assert.strictEqual(published[0].payload.v, 5);
      eng.stop();
      m.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
      resolve();
    });
  });
});
