const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Boot the app WITH auth enabled (each test file runs in its own process, so
// this env is set before ../index is required).
process.env.PORT = '0';
process.env.MANIFOLD_AUTH_TOKEN = 'test-secret-token';
process.env.MANIFOLD_TOKENS = 'alice:alice-token:admin,grafana:grafana-token:viewer';
process.env.MANIFOLD_NO_RESTORE = '1';
process.env.MANIFOLD_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'manifold-auth-test-'));

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

test('named tokens from MANIFOLD_TOKENS work with their roles', async () => {
  // alice: admin — mutation allowed (404 target is fine; not 401/403)
  const del = await fetch(`${baseUrl}/api/historians/nope`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer alice-token' }
  });
  assert.strictEqual(del.status, 404);

  // grafana: viewer — reads succeed, mutations are 403
  const read = await fetch(`${baseUrl}/api/system/status`, {
    headers: { Authorization: 'Bearer grafana-token' }
  });
  assert.strictEqual(read.status, 200);
  const mut = await fetch(`${baseUrl}/api/historians/nope`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer grafana-token' }
  });
  assert.strictEqual(mut.status, 403);
});

test('repeated auth failures hit the rate limit with 429', async () => {
  let last = 0;
  for (let i = 0; i < 25; i++) {
    const res = await fetch(`${baseUrl}/api/system/status`, {
      headers: { Authorization: 'Bearer guess-' + i }
    });
    last = res.status;
  }
  assert.strictEqual(last, 429, 'brute-force attempts must be throttled');
  // A valid token is never throttled.
  const ok = await fetch(`${baseUrl}/api/system/status`, {
    headers: { Authorization: 'Bearer test-secret-token' }
  });
  assert.strictEqual(ok.status, 200);
});
