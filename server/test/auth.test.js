const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Boot the app WITH auth enabled (each test file runs in its own process, so
// this env is set before ../index is required).
process.env.PORT = '0';
process.env.TC_AUTH_TOKEN = 'test-secret-token';
process.env.TC_NO_RESTORE = '1';

let baseUrl;
let server;

before(async () => {
  const app = require('../index');
  server = app.server;
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

test('API rejects requests without a bearer token', async () => {
  const res = await fetch(`${baseUrl}/api/system/status`);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.match(body.error, /Unauthorized/);
});

test('API rejects a wrong token', async () => {
  const res = await fetch(`${baseUrl}/api/system/status`, {
    headers: { Authorization: 'Bearer wrong-token' }
  });
  assert.strictEqual(res.status, 401);
});

test('API accepts the correct bearer token', async () => {
  const res = await fetch(`${baseUrl}/api/system/status`, {
    headers: { Authorization: 'Bearer test-secret-token' }
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.mqtt);
});

test('/health stays open (liveness probe, no data exposure)', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.strictEqual(res.status, 200);
});
