const { test } = require('node:test');
const assert = require('node:assert');

const MqttManager = require('../services/mqttManager');
const DiscoveryService = require('../services/discovery');
const CesmiiClient = require('../services/cesmiiClient');
const I3xClient = require('../services/i3xClient');

const fakeIo = { emit() {} };

test('discovery.expandCidr expands a /30 to usable hosts', () => {
  const d = new DiscoveryService(fakeIo);
  const hosts = d.expandCidr('192.168.1.0/30');
  // /30 has 4 addresses; network + broadcast are excluded
  assert.deepStrictEqual(hosts, ['192.168.1.1', '192.168.1.2']);
});

test('discovery.expandCidr handles a single /32 host', () => {
  const d = new DiscoveryService(fakeIo);
  assert.deepStrictEqual(d.expandCidr('10.0.0.5/32'), ['10.0.0.5']);
});

test('discovery.expandCidr rejects malformed input', () => {
  const d = new DiscoveryService(fakeIo);
  assert.throws(() => d.expandCidr('999.1.1.0/24'), /Invalid CIDR/);
  assert.throws(() => d.expandCidr('10.0.0.0/8'), /between \/16 and \/32/);
});

test('mqttManager.isSparkplugTopic detects Sparkplug B topics', () => {
  const m = new MqttManager(fakeIo);
  assert.ok(m.isSparkplugTopic('spBv1.0/group/NDATA/edge'));
  assert.ok(m.isSparkplugTopic('spBv1.0/g/DBIRTH/e/dev'));
  assert.ok(!m.isSparkplugTopic('factory/line1/temp'));
  m.shutdown();
});

test('mqttManager.detectMessageType classifies by topic and payload', () => {
  const m = new MqttManager(fakeIo);
  assert.strictEqual(m.detectMessageType('site/alarm/high', 'x'), 'alarm');
  assert.strictEqual(m.detectMessageType('dev/cmd', 'x'), 'command');
  assert.strictEqual(m.detectMessageType('dev/telemetry', 'x'), 'telemetry');
  assert.strictEqual(m.detectMessageType('dev/config', 'x'), 'configuration');
  assert.strictEqual(m.detectMessageType('dev/raw', { a: 1 }), 'json');
  assert.strictEqual(m.detectMessageType('dev/raw', 'plain'), 'text');
  m.shutdown();
});

test('mqttManager.subscribe falls back to QoS 0 when the broker refuses the grant', () => {
  const events = [];
  const m = new MqttManager({ emit: (ev, data) => events.push({ ev, data }) });
  // Fake client mimicking stock EMQX through mqtt.js: '#' at QoS 1+ → the
  // callback gets an ERROR carrying the SUBACK packet with granted [128]
  // (granted arg still echoes the request); QoS 0 → granted normally.
  const calls = [];
  const refusal = (topic, qos) => {
    const err = new Error('Subscribe error: Unspecified error');
    err.packet = { cmd: 'suback', granted: [128] };
    return [err, [{ topic, qos }]];
  };
  m.clients.set('b1', {
    subscribe(topic, opts, cb) {
      calls.push({ topic, qos: opts.qos });
      if (opts.qos > 0) cb(...refusal(topic, opts.qos));
      else cb(null, [{ topic, qos: 0 }]);
    },
    end() {}
  });
  m.subscriptions.set('b1', new Set());
  m.connections.set('b1', { status: 'connected' }); // requireClient checks live status

  m.subscribe('b1', '#', 1);
  assert.deepStrictEqual(calls, [
    { topic: '#', qos: 1 },
    { topic: '#', qos: 0 }
  ]);
  assert.ok(m.subscriptions.get('b1').has('#'), 'fallback subscription must be recorded');
  assert.ok(events.some((e) => e.ev === 'subscription-downgraded' && e.data.from === 1 && e.data.to === 0));
  assert.ok(events.some((e) => e.ev === 'subscription-success' && e.data.qos === 0));

  // Refused even at QoS 0 → surfaced as an error, not silence.
  m.subscriptions.get('b1').clear();
  events.length = 0;
  m.clients.set('b1', {
    subscribe(topic, opts, cb) {
      const err = new Error('Subscribe error: Not authorized');
      err.packet = { cmd: 'suback', granted: [135] };
      cb(err, [{ topic, qos: opts.qos }]);
    },
    end() {}
  });
  m.subscribe('b1', '$SYS/#', 0);
  assert.ok(events.some((e) => e.ev === 'subscription-error' && /refused/.test(e.data.error)));
  assert.ok(!m.subscriptions.get('b1').has('$SYS/#'));
  m.shutdown();
});

test('mqttManager.publish rejects (never throws) for a disconnected broker', async () => {
  const m = new MqttManager(fakeIo);
  // Direct call must reject, not throw.
  await assert.rejects(() => m.publish('nope', 'a/b', 'x'), /not connected/);
  // The replayer/model-engine pattern: fired from a timer with only .catch().
  // A synchronous throw here would escape as an uncaught exception and kill
  // the process — the await below only survives if publish stays async.
  const caught = await new Promise((resolve) => {
    setTimeout(() => {
      m.publish('nope', 'a/b', 'x').then(() => resolve(null)).catch((e) => resolve(e));
    }, 5);
  });
  assert.match(caught.message, /not connected/);
  m.shutdown();
});

test('cesmiiClient requires full configuration', () => {
  const c = new CesmiiClient();
  assert.strictEqual(c.isConfigured(), false);
  assert.throws(() => c.configure({ endpoint: 'https://x/graphql' }), /authenticator is required/);
  const status = c.configure({
    endpoint: 'https://demo.cesmii.net/graphql',
    authenticator: 'auth',
    role: 'role',
    userName: 'user',
    secret: 'secret'
  });
  assert.strictEqual(status.configured, true);
  assert.strictEqual(status.authenticated, false);
});

test('cesmiiClient.getHistory validates arguments before hitting the network', async () => {
  const c = new CesmiiClient();
  c.configure({
    endpoint: 'https://demo.cesmii.net/graphql',
    authenticator: 'a',
    role: 'r',
    userName: 'u',
    secret: 's'
  });
  await assert.rejects(() => c.getHistory([], '2024-01-01', '2024-01-02'), /non-empty array/);
  await assert.rejects(() => c.getHistory(['1'], null, null), /startTime and endTime are required/);
});

test('i3xClient requires a base URL and normalizes trailing slash', () => {
  const c = new I3xClient();
  assert.strictEqual(c.isConfigured(), false);
  assert.throws(() => c.configure({}), /baseUrl is required/);
  const status = c.configure({ baseUrl: 'https://api.i3x.dev/v1/' });
  assert.strictEqual(status.configured, true);
  assert.strictEqual(status.baseUrl, 'https://api.i3x.dev/v1');
});

test('i3xClient.buildGraph builds hierarchical + composition edges', () => {
  const c = new I3xClient();
  const { nodes, links } = c.buildGraph([
    { elementId: 'plant', displayName: 'Plant', parentId: null },
    { elementId: 'line', displayName: 'Line 1', parentId: 'plant', isComposition: true },
    { elementId: 'motor', displayName: 'Motor', parentId: 'line' }
  ]);
  assert.strictEqual(nodes.length, 3);
  assert.strictEqual(links.length, 2);
  const comp = links.find((l) => l.target === 'line');
  assert.strictEqual(comp.kind, 'composition');
});

test('i3xClient.getValues validates elementIds', async () => {
  const c = new I3xClient();
  c.configure({ baseUrl: 'https://api.i3x.dev/v1' });
  await assert.rejects(() => c.getValues([]), /non-empty array/);
});

test('discovery accepts an i3x dependency for endpoint verification', () => {
  const c = new I3xClient();
  const d = new DiscoveryService({ emit() {} }, { i3x: c });
  assert.strictEqual(typeof d.identifyI3xServer, 'function');
});

test('topicStore.topicAt survives growth and tracks slots', () => {
  const TopicStore = require('../services/topicStore');
  const s = new TopicStore();
  for (let i = 0; i < 3000; i++) s.ingest(`g/t${i}`, Buffer.from('x'), 0, false); // forces _grow past 1024/2048
  assert.strictEqual(s.topicAt(0), 'g/t0');
  assert.strictEqual(s.topicAt(2999), 'g/t2999');
});

test('mqttManager.resolveSubscriptions is lazy, incremental, and deduped', () => {
  const m = new MqttManager(fakeIo);
  const TopicStore = require('../services/topicStore');
  const brokerId = 'rb1';
  m.connections.set(brokerId, { id: brokerId, metrics: { messagesReceived: 0, bytesReceived: 0, topicCount: 0, errors: 0 } });
  m.stores.set(brokerId, new TopicStore());
  const store = m.stores.get(brokerId);
  store.ingest('plant/l1/temp', Buffer.from('1'), 0, false);
  store.ingest('plant/l2/temp', Buffer.from('2'), 0, true);
  store.ingest('$SYS/broker/version', Buffer.from('v'), 0, true);

  // duplicate filters dedupe to one result each
  const r1 = m.resolveSubscriptions(brokerId, ['plant/#', 'plant/#', '#']);
  assert.strictEqual(r1.results.length, 2);
  const plant = r1.results.find((x) => x.filter === 'plant/#');
  assert.strictEqual(plant.matchCount, 2);
  assert.ok(plant.sample.every((s2) => typeof s2.ts === 'number' && 'retain' in s2 && 'msgCount' in s2));
  const all = r1.results.find((x) => x.filter === '#');
  assert.strictEqual(all.matchCount, 2, '# must not match $SYS');

  // incremental: new topics after the trie was built are picked up
  store.ingest('plant/l3/temp', Buffer.from('3'), 0, false);
  const r2 = m.resolveSubscriptions(brokerId, ['plant/#']);
  assert.strictEqual(r2.results[0].matchCount, 3);
  assert.strictEqual(r2.topicTotal, 4);
  m.shutdown();
});

test('mqttManager.getTopicChildren returns hydrated one-level drill-down', () => {
  const m = new MqttManager(fakeIo);
  const TopicStore = require('../services/topicStore');
  const brokerId = 'rb2';
  m.connections.set(brokerId, { id: brokerId, metrics: { messagesReceived: 0, bytesReceived: 0, topicCount: 0, errors: 0 } });
  m.stores.set(brokerId, new TopicStore());
  const store = m.stores.get(brokerId);
  store.ingest('f/a/x', Buffer.from('1'), 0, false);
  store.ingest('f/a/y', Buffer.from('2'), 0, false);
  store.ingest('f/b', Buffer.from('3'), 0, true);

  const top = m.getTopicChildren(brokerId, 'f');
  assert.deepStrictEqual(top.children.map((c) => c.segment).sort(), ['a', 'b']);
  const b = top.children.find((c) => c.segment === 'b');
  assert.ok(b.isTopic && b.retain === true && b.msgCount === 1);
  const a = top.children.find((c) => c.segment === 'a');
  assert.strictEqual(a.subtreeCount, 2);
  m.shutdown();
});
