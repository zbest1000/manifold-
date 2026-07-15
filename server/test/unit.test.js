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

test('mqttManager.connectToBroker builds ws/wss URLs and applies MQTT 5 + TLS options', () => {
  // Intercept via the _mqttConnect seam (mqtt v5's module exports are
  // non-configurable getters, so mqtt.connect itself can't be stubbed).
  const m = new MqttManager(fakeIo);
  const calls = [];
  m._mqttConnect = (url, options) => {
    calls.push({ url, options });
    return { on() {}, end() {} };
  };
  try {
    // ws: explicit port required, wsPath (default /mqtt) lands in the URL.
    m.connectToBroker({ id: 'w1', host: 'edge', port: 8083, protocol: 'ws' });
    assert.strictEqual(calls[0].url, 'ws://edge:8083/mqtt');
    assert.ok(!('protocolVersion' in calls[0].options), 'v4 default must not set protocolVersion');

    // wss: custom path in the URL, TLS opts applied exactly like mqtts, v5 opt-in.
    m.connectToBroker({
      id: 'w2', host: 'edge', port: 443, protocol: 'wss', wsPath: '/broker',
      ca: 'CA', cert: 'CERT', key: 'KEY', mqttVersion: 5
    });
    assert.strictEqual(calls[1].url, 'wss://edge:443/broker');
    assert.strictEqual(calls[1].options.ca, 'CA');
    assert.strictEqual(calls[1].options.cert, 'CERT');
    assert.strictEqual(calls[1].options.key, 'KEY');
    assert.strictEqual(calls[1].options.protocolVersion, 5);

    // The info object round-trips the new fields for GET lists / the edit form.
    const info = m.getConnection('w2');
    assert.strictEqual(info.protocol, 'wss');
    assert.strictEqual(info.wsPath, '/broker');
    assert.strictEqual(info.mqttVersion, 5);
    assert.strictEqual(info.subscribeFilter, '#');
    const plain = m.getConnection('w1');
    assert.strictEqual(plain.mqttVersion, 4);

    // Validation: ws without a port, bad wsPath, bad version, bad protocol, empty filter.
    assert.throws(() => m.connectToBroker({ host: 'edge', protocol: 'ws' }), /port is required/);
    assert.throws(() => m.connectToBroker({ host: 'edge', protocol: 'wss' }), /port is required/);
    assert.throws(() => m.connectToBroker({ host: 'edge', protocol: 'ws', port: 8083, wsPath: 'mqtt' }), /wsPath/);
    assert.throws(() => m.connectToBroker({ host: 'edge', mqttVersion: 3 }), /mqttVersion must be 4 or 5/);
    assert.throws(() => m.connectToBroker({ host: 'edge', protocol: 'http' }), /protocol must be one of/);
    assert.throws(() => m.connectToBroker({ host: 'edge', subscribeFilter: '' }), /subscribeFilter/);
  } finally {
    m.shutdown();
  }
});

test('mqttManager autoSubscribe uses the configured subscribeFilter (incl. $share) with QoS fallback', () => {
  const m = new MqttManager(fakeIo);
  const handlers = {};
  const subs = [];
  m._mqttConnect = () => ({
    on(ev, fn) { handlers[ev] = fn; },
    // Mimic a broker that refuses the wildcard grant at QoS 1+ (SUBACK 0x80),
    // same shape as the existing fallback test.
    subscribe(topic, opts, cb) {
      subs.push({ topic, qos: opts.qos });
      if (opts.qos > 0) {
        const err = new Error('Subscribe error: Unspecified error');
        err.packet = { cmd: 'suback', granted: [128] };
        cb(err, [{ topic, qos: opts.qos }]);
      } else {
        cb(null, [{ topic, qos: 0 }]);
      }
    },
    end() {}
  });
  try {
    m.connectToBroker({ id: 's1', host: 'edge', subscribeFilter: '$share/manifold/#' });
    handlers.connect(); // broker accepts the connection → autoSubscribe fires
    assert.deepStrictEqual(subs, [
      { topic: '$share/manifold/#', qos: 1 }, // custom intake filter at the default QoS
      { topic: '$share/manifold/#', qos: 0 }, // refusal fallback keeps working with it
      { topic: '$SYS/#', qos: 0 } // secondary $SYS subscribe stays as is
    ]);
    assert.ok(m.subscriptions.get('s1').has('$share/manifold/#'));
  } finally {
    m.shutdown();
  }
});

test('mqttManager surfaces MQTT 5 packet properties on built messages', () => {
  const m = new MqttManager(fakeIo);
  const TopicStore = require('../services/topicStore');
  const brokerId = 'v5';
  m.connections.set(brokerId, { id: brokerId, mqttVersion: 5, metrics: { messagesReceived: 0, bytesReceived: 0, topicCount: 0, errors: 0 } });
  m.stores.set(brokerId, new TopicStore());
  m.topicMeta.set(brokerId, []);
  m.msgProps.set(brokerId, new Map());

  m.handleMessage(brokerId, 'plant/l1/temp', Buffer.from('{"v":1}'), {
    qos: 1,
    retain: false,
    properties: {
      userProperties: { trace: 't-1' },
      contentType: 'application/json',
      responseTopic: 'plant/l1/reply',
      correlationData: Buffer.from('abc')
    }
  });
  const [row] = m.stores.get(brokerId).drain();
  const msg = m.buildMessage(brokerId, row);
  assert.deepStrictEqual(msg.properties, {
    userProperties: { trace: 't-1' },
    contentType: 'application/json',
    responseTopic: 'plant/l1/reply',
    correlationData: Buffer.from('abc').toString('base64') // Buffers surface as base64
  });

  // v4-style packet (no properties key) → nothing attached, hot path untouched.
  m.handleMessage(brokerId, 'plant/l1/press', Buffer.from('3.1'), { qos: 0, retain: false });
  const rows = m.stores.get(brokerId).drain();
  const plain = m.buildMessage(brokerId, rows.find((r) => r.topic === 'plant/l1/press'));
  assert.ok(!('properties' in plain));

  // A later publish on the SAME topic without the surfaced keys clears them.
  m.handleMessage(brokerId, 'plant/l1/temp', Buffer.from('{"v":2}'), { qos: 1, retain: false, properties: {} });
  const [row2] = m.stores.get(brokerId).drain();
  assert.ok(!('properties' in m.buildMessage(brokerId, row2)));
  m.shutdown();
});

test('mqttManager.publish forwards MQTT 5 properties only on v5 sessions', async () => {
  const m = new MqttManager(fakeIo);
  const published = [];
  const fakeClient = {
    publish(topic, body, opts, cb) {
      published.push(opts);
      cb(null);
    },
    end() {}
  };
  const metrics = () => ({ messagesReceived: 0, messagesSent: 0, bytesReceived: 0, bytesSent: 0, topicCount: 0, errors: 0 });
  m.clients.set('p5', fakeClient);
  m.connections.set('p5', { status: 'connected', mqttVersion: 5, metrics: metrics() });
  m.clients.set('p4', fakeClient);
  m.connections.set('p4', { status: 'connected', mqttVersion: 4, metrics: metrics() });

  const properties = { userProperties: { source: 'manifold' }, contentType: 'text/plain', responseTopic: 'r/t' };
  await m.publish('p5', 't', 'x', { qos: 1, properties });
  await m.publish('p4', 't', 'x', { qos: 1, properties });
  assert.deepStrictEqual(published[0].properties, properties);
  assert.strictEqual(published[0].qos, 1);
  assert.ok(!('properties' in published[1]), 'v4 sessions must silently drop publish properties');
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
