const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

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

// ---- value-threshold rules (live message tap) ----------------------------------

// The engine only needs `.on/.off('message')` from the manager for value rules,
// so a bare EventEmitter is a faithful fake of the tap.
function valueEngine(rules) {
  const manager = new EventEmitter();
  const io = fakeIo();
  const eng = new AlertEngine({ io, profiles: { alertRules: () => rules }, mqttManager: manager, fetchImpl: null });
  eng.start();
  return { manager, io, eng };
}

const msg = (brokerId, topic, payload) => ({ brokerId, topic, payload, timestamp: new Date().toISOString() });

test('value-threshold fires on breach via the manager tap and resolves on clear', () => {
  const rules = [{ id: 'v1', type: 'value-threshold', brokerId: 'b1', topic: 'plant/line1/temp', op: '>', value: 80 }];
  const { manager, io, eng } = valueEngine(rules);

  manager.emit('message', msg('b1', 'plant/line1/temp', 75));
  assert.strictEqual(io.emitted.length, 0, 'below the limit must not fire');

  manager.emit('message', msg('b1', 'plant/line1/temp', 90));
  assert.strictEqual(io.emitted.length, 1);
  assert.strictEqual(io.emitted[0].data.status, 'firing');
  assert.strictEqual(io.emitted[0].data.value, 90);
  assert.strictEqual(io.emitted[0].data.topic, 'plant/line1/temp');

  // still breached → no duplicate firing
  manager.emit('message', msg('b1', 'plant/line1/temp', 95));
  assert.strictEqual(io.emitted.length, 1);

  manager.emit('message', msg('b1', 'plant/line1/temp', 60));
  assert.strictEqual(io.emitted.length, 2);
  assert.strictEqual(io.emitted[1].data.status, 'resolved');
  assert.strictEqual(io.emitted[1].data.value, 60);

  eng.stop();
  assert.strictEqual(manager.listenerCount('message'), 0, 'stop() must detach the tap');
});

test('value-threshold sustainMs holds firing until the breach persists continuously', () => {
  const rules = [{ id: 'v2', type: 'value-threshold', brokerId: 'b1', topic: 't', op: '>=', value: 100, sustainMs: 40 }];
  const { io, eng } = valueEngine(rules);
  const t0 = Date.now();

  eng.onMessage(msg('b1', 't', 100), t0);
  eng.onMessage(msg('b1', 't', 120), t0 + 10);
  assert.strictEqual(io.emitted.length, 0, 'breach younger than sustainMs must not fire');

  // condition drops → sustain clock resets
  eng.onMessage(msg('b1', 't', 50), t0 + 20);
  eng.onMessage(msg('b1', 't', 130), t0 + 30);
  eng.onMessage(msg('b1', 't', 130), t0 + 65);
  assert.strictEqual(io.emitted.length, 0, 'reset breach at +30 is only 35ms old at +65');

  eng.onMessage(msg('b1', 't', 130), t0 + 75);
  assert.strictEqual(io.emitted.length, 1);
  assert.strictEqual(io.emitted[0].data.status, 'firing');
  eng.stop();
});

test('value-threshold keeps independent state per concrete topic under a wildcard', () => {
  // Regression: a wildcard rule used to share ONE sustain/firing machine across
  // every matched topic, so a normal reading on one topic reset another topic's
  // sustain clock and suppressed a real, sustained breach.
  const rules = [{ id: 'vw', type: 'value-threshold', brokerId: 'b1', topic: 'plant/+/temp', op: '>', value: 80, sustainMs: 30 }];
  const { eng, io } = valueEngine(rules);
  const t0 = Date.now();

  // Pump A is genuinely overheating and stays breached the whole time.
  eng.onMessage(msg('b1', 'plant/A/temp', 95), t0);
  // Pump B keeps reporting normal values that would reset a shared clock.
  eng.onMessage(msg('b1', 'plant/B/temp', 20), t0 + 5);
  eng.onMessage(msg('b1', 'plant/B/temp', 20), t0 + 15);
  eng.onMessage(msg('b1', 'plant/A/temp', 96), t0 + 25);
  assert.strictEqual(io.emitted.length, 0, 'A breach younger than sustainMs must not fire yet');

  // A has now been continuously breached for > 30ms — it MUST fire, and cite A.
  eng.onMessage(msg('b1', 'plant/A/temp', 97), t0 + 40);
  assert.strictEqual(io.emitted.length, 1, "A's sustained breach must fire despite B's normal readings");
  assert.strictEqual(io.emitted[0].data.status, 'firing');
  assert.strictEqual(io.emitted[0].data.topic, 'plant/A/temp');

  // Resolving A must cite A, not B.
  eng.onMessage(msg('b1', 'plant/A/temp', 10), t0 + 50);
  assert.strictEqual(io.emitted.length, 2);
  assert.strictEqual(io.emitted[1].data.status, 'resolved');
  assert.strictEqual(io.emitted[1].data.topic, 'plant/A/temp');
  eng.stop();
});

test('value-threshold extracts nested fields via dot-path', () => {
  const rules = [{ id: 'v3', type: 'value-threshold', brokerId: 'b1', topic: 'machine/state', field: 'data.temp', op: '<', value: 10 }];
  const { manager, io, eng } = valueEngine(rules);

  manager.emit('message', msg('b1', 'machine/state', { data: { temp: 15 } }));
  assert.strictEqual(io.emitted.length, 0);
  manager.emit('message', msg('b1', 'machine/state', { data: { temp: 3 } }));
  assert.strictEqual(io.emitted.length, 1);
  assert.strictEqual(io.emitted[0].data.value, 3);
  // path missing → ignored, state untouched
  manager.emit('message', msg('b1', 'machine/state', { other: 1 }));
  assert.strictEqual(io.emitted.length, 1);
  eng.stop();
});

test('value-threshold matches topic filters with + and respects brokerId', () => {
  const rules = [{ id: 'v4', type: 'value-threshold', brokerId: 'b1', topic: 'plant/+/temp', op: '>', value: 80 }];
  const { manager, io, eng } = valueEngine(rules);

  manager.emit('message', msg('b2', 'plant/line1/temp', 99)); // wrong broker
  manager.emit('message', msg('b1', 'plant/line1/hum', 99)); // filter miss
  manager.emit('message', msg('b1', 'plant/line1/temp/extra', 99)); // deeper than filter
  assert.strictEqual(io.emitted.length, 0);

  manager.emit('message', msg('b1', 'plant/line7/temp', 99));
  assert.strictEqual(io.emitted.length, 1);
  assert.strictEqual(io.emitted[0].data.topic, 'plant/line7/temp');
  eng.stop();
});

test('value-threshold ignores non-numeric payloads and coercion traps', () => {
  const rules = [
    { id: 'v5', type: 'value-threshold', brokerId: 'b1', topic: 'a', op: '>', value: 0 },
    { id: 'v6', type: 'value-threshold', brokerId: 'b1', topic: 'b', field: 'v', op: '>', value: 0 }
  ];
  const { manager, io, eng } = valueEngine(rules);

  manager.emit('message', msg('b1', 'a', 'hello'));
  manager.emit('message', msg('b1', 'a', '')); // Number('') === 0 — must not evaluate
  manager.emit('message', msg('b1', 'a', true)); // Number(true) === 1 — must not evaluate
  manager.emit('message', msg('b1', 'a', { v: 5 })); // object without a field path
  manager.emit('message', msg('b1', 'b', { v: 'not-a-number' }));
  manager.emit('message', msg('b1', 'b', 42)); // scalar payload but rule wants a field
  assert.strictEqual(io.emitted.length, 0);

  manager.emit('message', msg('b1', 'a', '5')); // numeric string is honest data
  manager.emit('message', msg('b1', 'b', { v: 5 }));
  assert.strictEqual(io.emitted.length, 2);
  eng.stop();
});

test('value-threshold clearValue hysteresis holds firing through the deadband', () => {
  const rules = [{ id: 'v7', type: 'value-threshold', brokerId: 'b1', topic: 't', op: '>', value: 80, clearValue: 75 }];
  const { manager, io, eng } = valueEngine(rules);

  manager.emit('message', msg('b1', 't', 90));
  assert.strictEqual(io.emitted.length, 1);
  assert.strictEqual(io.emitted[0].data.status, 'firing');

  // 78 is below the limit but above the clear level → still firing, no flap
  manager.emit('message', msg('b1', 't', 78));
  assert.strictEqual(io.emitted.length, 1);

  // dipping back into breach from the deadband must not re-fire
  manager.emit('message', msg('b1', 't', 85));
  assert.strictEqual(io.emitted.length, 1);

  manager.emit('message', msg('b1', 't', 74));
  assert.strictEqual(io.emitted.length, 2);
  assert.strictEqual(io.emitted[1].data.status, 'resolved');

  // fresh breach after resolve fires again
  manager.emit('message', msg('b1', 't', 81));
  assert.strictEqual(io.emitted.length, 3);
  assert.strictEqual(io.emitted[2].data.status, 'firing');
  eng.stop();
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
