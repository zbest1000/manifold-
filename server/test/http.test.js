const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Boot the real app on an ephemeral port and exercise the HTTP surface.
// Isolation matters: without MANIFOLD_NO_RESTORE the app would reconnect whatever
// brokers a previous run persisted into the real data dir — live MQTT sockets
// whose reconnect timers keep this test process alive forever (and make
// "starts empty" assertions lie). Same for MANIFOLD_DATA_DIR: point persistence at a
// throwaway dir so the test never reads or pollutes real state.
process.env.PORT = '0';
process.env.MANIFOLD_NO_RESTORE = '1';
process.env.MANIFOLD_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'manifold-http-test-'));
let baseUrl;
let server;
let services;

before(async () => {
  const app = require('../index');
  server = app.server;
  services = app.app.locals.services;
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  // Stop everything that could hold the event loop open.
  services?.mqttManager?.shutdown();
  services?.history?.stop();
  services?.alerts?.stop();
  services?.pipelines?.stop();
  services?.recorder?.stop();
  services?.replayer?.stop();
  services?.contracts?.stop();
  services?.models?.stop();
  server?.close();
});

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function put(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

test('GET /health reports healthy', async () => {
  const { status, body } = await get('/health');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.status, 'healthy');
});

test('GET /api/system/status includes all subsystems', async () => {
  const { status, body } = await get('/api/system/status');
  assert.strictEqual(status, 200);
  assert.ok(body.mqtt);
  assert.ok(body.opcua);
  assert.ok(body.discovery);
  assert.ok(body.cesmii);
  assert.strictEqual(body.cesmii.configured, false);
  assert.ok(body.i3x);
  assert.strictEqual(body.i3x.configured, false);
});

test('POST /api/i3x/probe requires baseUrl', async () => {
  const { status, body } = await post('/api/i3x/probe', {});
  assert.strictEqual(status, 400);
  assert.match(body.error, /baseUrl is required/);
});

test('GET /api/i3x/namespaces fails cleanly when not connected', async () => {
  const { status, body } = await get('/api/i3x/namespaces');
  assert.strictEqual(status, 400);
  assert.match(body.error, /not configured/);
});

test('GET /api/mqtt/brokers starts empty', async () => {
  const { status, body } = await get('/api/mqtt/brokers');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body.brokers, []);
});

test('POST /api/mqtt/brokers validates required fields', async () => {
  const { status, body } = await post('/api/mqtt/brokers', {});
  assert.strictEqual(status, 400);
  assert.match(body.error, /host is required/);
});

test('POST /api/cesmii/config validates required fields', async () => {
  const { status, body } = await post('/api/cesmii/config', { endpoint: 'https://x/graphql' });
  assert.strictEqual(status, 400);
  assert.match(body.error, /required/);
});

test('unknown OPC UA connection returns 404 on delete', async () => {
  const res = await fetch(`${baseUrl}/api/opcua/connections/does-not-exist`, { method: 'DELETE' });
  assert.strictEqual(res.status, 404);
});

test('PUT /api/mqtt/brokers/:id returns 404 for unknown ids', async () => {
  const { status, body } = await put('/api/mqtt/brokers/does-not-exist', { host: 'localhost' });
  assert.strictEqual(status, 404);
  assert.match(body.error, /not found/i);
});

test('PUT /api/opcua/connections/:id returns 404 for unknown ids', async () => {
  const { status, body } = await put('/api/opcua/connections/does-not-exist', { endpointUrl: 'opc.tcp://x:4840' });
  assert.strictEqual(status, 404);
  assert.match(body.error, /not found/i);
});

test('PUT /api/mqtt/brokers/:id validates like POST and updates the profile in place', async () => {
  // A closed local port is enough: the manager registers the connection
  // without ever reaching a real broker (reconnect off keeps it quiet).
  const created = await post('/api/mqtt/brokers', { name: 'edit-me', host: '127.0.0.1', port: 59999, reconnect: false });
  assert.strictEqual(created.status, 202);
  const id = created.body.brokerId;

  // Same validation as POST — and the bad body must not drop the broker.
  const bad = await put(`/api/mqtt/brokers/${id}`, {});
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /host is required/);
  assert.ok((await get(`/api/mqtt/brokers/${id}`)).status === 200, 'broker must survive a rejected update');

  const updated = await put(`/api/mqtt/brokers/${id}`, { name: 'edited', host: '127.0.0.1', port: 59998, reconnect: false });
  assert.strictEqual(updated.status, 202);
  assert.strictEqual(updated.body.brokerId, id);

  // Profile store keeps the SAME id with the new config…
  const saved = services.profiles.brokers().find((b) => b.config?.id === id);
  assert.ok(saved, 'profile entry must survive the update');
  assert.strictEqual(saved.config.name, 'edited');
  assert.strictEqual(saved.config.port, 59998);

  // …and the live connection list reflects it too.
  const list = await get('/api/mqtt/brokers');
  const conn = list.body.brokers.find((b) => b.id === id);
  assert.strictEqual(conn.name, 'edited');
  assert.strictEqual(conn.port, 59998);

  await fetch(`${baseUrl}/api/mqtt/brokers/${id}`, { method: 'DELETE' });
});

test('POST /api/mqtt/brokers validates transport/session fields', async () => {
  // ws/wss have no standard MQTT port — an explicit one is required.
  const noPort = await post('/api/mqtt/brokers', { host: 'localhost', protocol: 'ws' });
  assert.strictEqual(noPort.status, 400);
  assert.match(noPort.body.error, /port is required/);

  const badPath = await post('/api/mqtt/brokers', { host: 'localhost', protocol: 'ws', port: 8083, wsPath: 'mqtt' });
  assert.strictEqual(badPath.status, 400);
  assert.match(badPath.body.error, /wsPath/);

  const badProtocol = await post('/api/mqtt/brokers', { host: 'localhost', protocol: 'http' });
  assert.strictEqual(badProtocol.status, 400);
  assert.match(badProtocol.body.error, /protocol must be one of/);

  const badVersion = await post('/api/mqtt/brokers', { host: 'localhost', mqttVersion: 3 });
  assert.strictEqual(badVersion.status, 400);
  assert.match(badVersion.body.error, /mqttVersion must be 4 or 5/);

  const badFilter = await post('/api/mqtt/brokers', { host: 'localhost', subscribeFilter: '' });
  assert.strictEqual(badFilter.status, 400);
  assert.match(badFilter.body.error, /subscribeFilter/);

  // PUT validates the same fields (and must not tear down anything on 400).
  const created = await post('/api/mqtt/brokers', { name: 'v-test', host: '127.0.0.1', port: 59997, reconnect: false });
  assert.strictEqual(created.status, 202);
  const id = created.body.brokerId;
  const badPut = await put(`/api/mqtt/brokers/${id}`, { host: '127.0.0.1', protocol: 'wss' });
  assert.strictEqual(badPut.status, 400);
  assert.match(badPut.body.error, /port is required/);
  assert.ok((await get(`/api/mqtt/brokers/${id}`)).status === 200, 'broker must survive a rejected update');
  await fetch(`${baseUrl}/api/mqtt/brokers/${id}`, { method: 'DELETE' });
});

test('ws broker config round-trips wsPath/mqttVersion/subscribeFilter through the info object', async () => {
  // A closed local port is enough — the WebSocket never connects, but the
  // manager registers the connection with its full info object.
  const created = await post('/api/mqtt/brokers', {
    name: 'ws-test', host: '127.0.0.1', port: 59996, protocol: 'ws',
    wsPath: '/mqtt-ws', mqttVersion: 5, subscribeFilter: '$share/g1/#', reconnect: false
  });
  assert.strictEqual(created.status, 202);
  const id = created.body.brokerId;
  const { status, body } = await get(`/api/mqtt/brokers/${id}`);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.broker.protocol, 'ws');
  assert.strictEqual(body.broker.wsPath, '/mqtt-ws');
  assert.strictEqual(body.broker.mqttVersion, 5);
  assert.strictEqual(body.broker.subscribeFilter, '$share/g1/#');
  // Non-ws brokers must not carry a wsPath in the serialized info.
  const plain = await post('/api/mqtt/brokers', { host: '127.0.0.1', port: 59995, reconnect: false });
  const plainInfo = await get(`/api/mqtt/brokers/${plain.body.brokerId}`);
  assert.ok(!('wsPath' in plainInfo.body.broker));
  assert.strictEqual(plainInfo.body.broker.mqttVersion, 4);
  assert.strictEqual(plainInfo.body.broker.subscribeFilter, '#');
  await fetch(`${baseUrl}/api/mqtt/brokers/${id}`, { method: 'DELETE' });
  await fetch(`${baseUrl}/api/mqtt/brokers/${plain.body.brokerId}`, { method: 'DELETE' });
});

test('POST /publish validates MQTT 5 properties shape before anything else', async () => {
  const badUser = await post('/api/mqtt/brokers/nope/publish', {
    topic: 't',
    properties: { userProperties: { a: 1 } }
  });
  assert.strictEqual(badUser.status, 400);
  assert.match(badUser.body.error, /userProperties/);

  const badShape = await post('/api/mqtt/brokers/nope/publish', { topic: 't', properties: 'nope' });
  assert.strictEqual(badShape.status, 400);
  assert.match(badShape.body.error, /properties must be an object/);

  const badContentType = await post('/api/mqtt/brokers/nope/publish', { topic: 't', properties: { contentType: 5 } });
  assert.strictEqual(badContentType.status, 400);
  assert.match(badContentType.body.error, /contentType/);
});

test('POST /subscriptions/resolve validates filters and 404s unknown brokers', async () => {
  const r404 = await post('/api/mqtt/brokers/nope/subscriptions/resolve', { filters: ['#'] });
  assert.strictEqual(r404.status, 404);
});

test('GET /topictree 404s unknown brokers', async () => {
  const res = await fetch(`${baseUrl}/api/mqtt/brokers/nope/topictree`);
  assert.strictEqual(res.status, 404);
});
