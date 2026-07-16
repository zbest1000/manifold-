const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { io } = require('socket.io-client');

// Boot the app with admin + viewer tokens and exercise the Socket.IO handshake
// and per-packet role gate directly — this is a first-class equipment-actuation
// surface (publish-message reaches mqttManager.publish), and before this file it
// had ZERO tests, so a regression letting an unauth/viewer socket publish would
// have shipped green.
process.env.PORT = '0';
process.env.MANIFOLD_AUTH_TOKEN = 'admin-token';
process.env.MANIFOLD_VIEWER_TOKEN = 'viewer-token';
process.env.MANIFOLD_NO_RESTORE = '1';
process.env.MANIFOLD_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'manifold-socket-test-'));

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
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  services?.mqttManager?.shutdown();
  for (const s of ['history', 'alerts', 'pipelines', 'recorder', 'replayer', 'contracts', 'models', 'outbox', 'bindings']) {
    services?.[s]?.stop?.();
  }
  services?.audit?.close();
  server?.close();
});

/** Open a socket with the given auth token; resolve on connect, reject on connect_error. */
function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
      timeout: 3000
    });
    // Attach the snapshot listener at creation — the server emits state-snapshot
    // immediately after connection, so a listener attached only after 'connect'
    // races and can miss it.
    socket.snapshot = new Promise((res) => socket.once('state-snapshot', res));
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => {
      socket.close();
      reject(err);
    });
  });
}

test('handshake rejects a socket with no token', async () => {
  await assert.rejects(connect(null), /Unauthorized/);
});

test('handshake rejects a socket with a wrong token', async () => {
  await assert.rejects(connect('nope'), /Unauthorized/);
});

test('viewer socket connects and hydrates but cannot publish (equipment actuation is blocked)', async () => {
  const socket = await connect('viewer-token');
  try {
    // Hydration snapshot must arrive (listener was attached at socket creation).
    await Promise.race([
      socket.snapshot,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no state-snapshot')), 2000))
    ]);

    // A viewer's publish must be refused with a read-only error AND must never
    // reach the manager. Spy on mqttManager.publish to prove it is not called.
    const mgr = services.mqttManager;
    const original = mgr.publish;
    let publishCalled = false;
    mgr.publish = async (...args) => {
      publishCalled = true;
      return original.apply(mgr, args);
    };
    try {
      const err = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no error-message for viewer publish')), 2000);
        socket.once('error-message', (e) => {
          clearTimeout(t);
          resolve(e);
        });
        socket.emit('publish-message', { brokerId: 'x', topic: 'plant/line1/cmd', payload: 'STOP' });
      });
      assert.match(err.error, /read-only/i);
      // Give any (erroneous) async publish a tick to land before asserting.
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(publishCalled, false, 'viewer publish must never reach mqttManager.publish');
    } finally {
      mgr.publish = original;
    }
  } finally {
    socket.close();
  }
});

test('admin socket mutation is audited as a SOCKET entry', async () => {
  const socket = await connect('admin-token');
  try {
    // start-discovery is a mutating event; it fails fast (no real scan target)
    // but the audit middleware records the attempt before the handler runs.
    socket.emit('start-discovery', { range: '203.0.113.0/30' });
    await new Promise((r) => setTimeout(r, 200));
    const socketEntries = services.audit.recent(50).filter((e) => e.method === 'SOCKET');
    const entry = socketEntries.find((e) => e.path === 'start-discovery');
    assert.ok(entry, 'socket mutation must be audited');
    assert.strictEqual(entry.role, 'admin');
    assert.strictEqual(entry.tokenName, 'admin');
  } finally {
    socket.close();
  }
});
