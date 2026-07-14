const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const MqttManager = require('../services/mqttManager');
const TopicStore = require('../services/topicStore');
const { AlertEngine, RULE_TYPES } = require('../services/alertEngine');
const HistoryStore = require('../services/historyStore');

const fakeIo = () => {
  const emitted = [];
  return { emit: (ev, data) => emitted.push({ ev, data }), emitted };
};

function managerWith(brokerId, topics) {
  const m = new MqttManager({ emit() {} });
  m.connections.set(brokerId, { id: brokerId, metrics: { messagesReceived: 0, bytesReceived: 0, topicCount: 0, errors: 0 } });
  m.stores.set(brokerId, new TopicStore());
  for (const t of topics) m.stores.get(brokerId).ingest(t, Buffer.from('x'), 0, false);
  return m;
}

test('branch-silent rule fires on silence and resolves on activity', () => {
  const m = managerWith('b1', ['plant/line1/temp']);
  const io = fakeIo();
  const rules = [{ id: 'r1', type: 'branch-silent', brokerId: 'b1', path: 'plant', thresholdMs: 60_000 }];
  const eng = new AlertEngine({ io, profiles: { alertRules: () => rules }, mqttManager: m, fetchImpl: null });

  // fresh data → no alert
  eng.evaluate(Date.now());
  assert.strictEqual(io.emitted.length, 0);

  // simulate 2 minutes of silence by evaluating "in the future"
  eng.evaluate(Date.now() + 120_000);
  assert.strictEqual(io.emitted.length, 1);
  assert.strictEqual(io.emitted[0].data.status, 'firing');
  assert.match(io.emitted[0].data.detail, /Silent for/);

  // still silent → no duplicate firing
  eng.evaluate(Date.now() + 180_000);
  assert.strictEqual(io.emitted.length, 1);

  // data returns → resolved
  m.stores.get('b1').ingest('plant/line1/temp', Buffer.from('y'), 0, false);
  eng.evaluate(Date.now());
  assert.strictEqual(io.emitted.length, 2);
  assert.strictEqual(io.emitted[1].data.status, 'resolved');
  m.shutdown();
});

test('branch never observed fires with "no data ever" detail', () => {
  const m = managerWith('b2', ['other/x']);
  const io = fakeIo();
  const rules = [{ id: 'r2', type: 'branch-silent', brokerId: 'b2', path: 'ghost/branch', thresholdMs: 1000 }];
  const eng = new AlertEngine({ io, profiles: { alertRules: () => rules }, mqttManager: m, fetchImpl: null });
  eng.evaluate();
  assert.strictEqual(io.emitted.length, 1);
  assert.match(io.emitted[0].data.detail, /No data ever observed/);
  m.shutdown();
});

test('new-topic rule fires per new topic under prefix after the watermark', () => {
  const m = managerWith('b3', ['plant/existing']);
  const io = fakeIo();
  const rules = [{ id: 'r3', type: 'new-topic', brokerId: 'b3', prefix: 'plant/' }];
  const eng = new AlertEngine({ io, profiles: { alertRules: () => rules }, mqttManager: m, fetchImpl: null });

  eng.evaluate(); // arms the watermark; pre-existing topics don't fire
  assert.strictEqual(io.emitted.length, 0);

  m.stores.get('b3').ingest('plant/new1', Buffer.from('x'), 0, false);
  m.stores.get('b3').ingest('elsewhere/new2', Buffer.from('x'), 0, false); // outside prefix
  eng.evaluate();
  assert.strictEqual(io.emitted.length, 1);
  assert.strictEqual(io.emitted[0].data.topic, 'plant/new1');
  m.shutdown();
});

test('webhook is POSTed with the alert payload; failures are swallowed', async () => {
  const m = managerWith('b4', ['a/b']);
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    throw new Error('connection refused'); // must not break evaluation
  };
  const rules = [{ id: 'r4', type: 'branch-silent', brokerId: 'b4', path: 'a', thresholdMs: 1000, webhookUrl: 'http://hook.local/x' }];
  const eng = new AlertEngine({ io: { emit() {} }, profiles: { alertRules: () => rules }, mqttManager: m, fetchImpl });
  eng.evaluate(Date.now() + 10_000);
  await new Promise((r) => setImmediate(r)); // let the rejected webhook settle
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'http://hook.local/x');
  assert.strictEqual(calls[0].body.status, 'firing');
  assert.strictEqual(eng.getEvents()[0].status, 'firing');
  m.shutdown();
});

test('disabled rules and unknown brokers are skipped without error', () => {
  const m = managerWith('b5', ['a/b']);
  const io = fakeIo();
  const rules = [
    { id: 'r5', type: 'branch-silent', brokerId: 'b5', path: 'a', thresholdMs: 1000, enabled: false },
    { id: 'r6', type: 'topic-silent', brokerId: 'missing-broker', topic: 'x', thresholdMs: 1000 }
  ];
  const eng = new AlertEngine({ io, profiles: { alertRules: () => rules }, mqttManager: m, fetchImpl: null });
  eng.evaluate(Date.now() + 60_000);
  assert.strictEqual(io.emitted.length, 0);
  assert.ok(RULE_TYPES.includes('branch-silent'));
  m.shutdown();
});

test('historyStore snapshots recent rings and restores them into empty rings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-hist-'));
  const m1 = new MqttManager({ emit() {} });
  m1.recent.set('bk', [
    { id: 1, brokerId: 'bk', topic: 'a/b', payload: 'x', timestamp: new Date().toISOString() },
    { id: 2, brokerId: 'bk', topic: 'a/c', payload: 'y', timestamp: new Date().toISOString() }
  ]);
  m1.msgSeq = 2;
  const h1 = new HistoryStore(m1, dir);
  assert.strictEqual(h1.snapshot({ sync: true }), true);
  assert.strictEqual(h1.snapshot({ sync: true }), false, 'idle managers must not rewrite the snapshot');

  const m2 = new MqttManager({ emit() {} });
  m2.recent.set('bk', []); // broker reconnected, ring empty
  m2.recent.set('other', [{ id: 9, topic: 'live' }]); // non-empty ring must be left alone
  const h2 = new HistoryStore(m2, dir);
  const n = h2.restore();
  assert.strictEqual(n, 2);
  assert.strictEqual(m2.recent.get('bk').length, 2);
  assert.ok(m2.recent.get('bk')[0].restored);
  assert.strictEqual(m2.recent.get('other').length, 1);
  m1.shutdown();
  m2.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});
