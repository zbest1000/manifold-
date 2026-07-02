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
