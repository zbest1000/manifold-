const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Boot the real app on an ephemeral port and exercise the HTTP surface.
process.env.PORT = '0';
let baseUrl;
let server;

before(async () => {
  const app = require('../index');
  server = app.server;
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
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
