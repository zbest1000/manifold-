const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the PKI at a throwaway dir BEFORE the manager is loaded so the lazy
// certificate manager never touches (or pollutes) the real data dir — the
// same isolation trick the other suites use for MANIFOLD_DATA_DIR.
process.env.MANIFOLD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-opcuasec-'));

const express = require('express');
const OpcuaManager = require('../services/opcuaManager');
const opcuaRoutes = require('../routes/opcua');

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  const io = { emit() {} }; // socket.io stub — routes only need emit()
  app.locals.services = { opcuaManager: new OpcuaManager(io) };
  app.use('/api/opcua', opcuaRoutes);
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

async function get(p) {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json() };
}

async function post(p, body) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

// First-time PKI init generates an RSA key + self-signed cert — give it room
// on slow CI boxes (keySize is already 2048, the smallest node-opcua allows).
test('GET /api/opcua/certificate returns the application certificate PEM', { timeout: 120_000 }, async () => {
  const r = await get('/api/opcua/certificate');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.pem.startsWith('-----BEGIN CERTIFICATE-----'), 'expected a PEM certificate');
  assert.match(r.body.thumbprint, /^[0-9a-f]{40}$/i, 'expected a SHA1 thumbprint');
  assert.strictEqual(r.body.applicationUri, 'urn:manifold:client');
  assert.ok(r.body.subject, 'expected a parsed subject');
  assert.ok(r.body.validTo, 'expected a validity end date');
  // and the PKI landed inside the isolated data dir
  assert.ok(r.body.pkiFolder.startsWith(process.env.MANIFOLD_DATA_DIR));
  assert.ok(fs.existsSync(path.join(process.env.MANIFOLD_DATA_DIR, 'pki', 'own', 'certs', 'client_certificate.pem')));
});

test('GET /api/opcua/trust on an empty PKI returns empty trusted/rejected lists', async () => {
  const r = await get('/api/opcua/trust');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.trusted, []);
  assert.deepStrictEqual(r.body.rejected, []);
});

test('POST /api/opcua/discover without endpointUrl is a 400', async () => {
  const r = await post('/api/opcua/discover', {});
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /endpointUrl/);
});

test('POST /api/opcua/trust validates thumbprint and 404s on unknown ones', async () => {
  const missing = await post('/api/opcua/trust', {});
  assert.strictEqual(missing.status, 400);
  assert.match(missing.body.error, /thumbprint/);

  const unknown = await post('/api/opcua/trust', { thumbprint: 'deadbeef'.repeat(5) });
  assert.strictEqual(unknown.status, 404);
  assert.match(unknown.body.error, /no rejected certificate/);
});

test('POST /api/opcua/trust moves a rejected certificate to trusted', async () => {
  // Stand-in "server" certificate: drop our own app cert into rejected/.
  const cert = (await get('/api/opcua/certificate')).body;
  const rejectedDir = path.join(process.env.MANIFOLD_DATA_DIR, 'pki', 'rejected');
  fs.writeFileSync(path.join(rejectedDir, 'fake_server.pem'), cert.pem);

  let list = (await get('/api/opcua/trust')).body;
  assert.strictEqual(list.rejected.length, 1);
  assert.strictEqual(list.rejected[0].thumbprint.toLowerCase(), cert.thumbprint.toLowerCase());

  // Thumbprint matching is case-insensitive.
  const r = await post('/api/opcua/trust', { thumbprint: cert.thumbprint.toUpperCase() });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'trusted');

  list = (await get('/api/opcua/trust')).body;
  assert.deepStrictEqual(list.rejected, []);
  assert.strictEqual(list.trusted.length, 1);
  assert.strictEqual(list.trusted[0].thumbprint.toLowerCase(), cert.thumbprint.toLowerCase());
});
