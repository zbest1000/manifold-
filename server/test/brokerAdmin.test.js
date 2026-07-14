const { test } = require('node:test');
const assert = require('node:assert');

const { fetchPubSub, supportedTypes } = require('../services/brokerAdmin');

// Fake EMQX REST: two pages of subscriptions, one page of clients, and records
// the Authorization header so we can assert Basic auth is sent.
function fakeEmqx({ captureAuth } = {}) {
  return async (url, opts) => {
    if (captureAuth) captureAuth(opts.headers.Authorization);
    const u = new URL(url);
    const page = Number(u.searchParams.get('page'));
    if (u.pathname.endsWith('/clients')) {
      return json({
        data: [{ clientid: 'sensor-1', username: 'u', ip_address: '10.0.0.5', connected: true, subscriptions_cnt: 2, recv_msg: 120, send_msg: 45, recv_oct: 9000, send_oct: 3000, connected_at: '2026-07-13T00:00:00Z' }],
        meta: { hasnext: false }
      });
    }
    if (u.pathname.endsWith('/subscriptions')) {
      if (page === 1) return json({ data: [{ clientid: 'sensor-1', topic: 'factory/#', qos: 1 }], meta: { hasnext: true } });
      return json({ data: [{ clientid: 'sensor-1', topic: 'alerts/+', qos: 0 }], meta: { hasnext: false } });
    }
    return json({ data: [], meta: { hasnext: false } });
  };
}
const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

test('supportedTypes lists emqx and hivemq', () => {
  assert.ok(supportedTypes().includes('emqx'));
  assert.ok(supportedTypes().includes('hivemq'));
});

test('EMQX backend normalizes clients + paginated subscriptions', async () => {
  let auth;
  const out = await fetchPubSub({ type: 'emqx', url: 'http://h:18083/api/v5', apiKey: 'k', apiSecret: 's' }, fakeEmqx({ captureAuth: (a) => (auth = a) }));

  assert.strictEqual(out.source, 'emqx');
  assert.strictEqual(out.clients.length, 1);
  assert.strictEqual(out.clients[0].id, 'sensor-1');
  assert.strictEqual(out.clients[0].subscriptionsCount, 2);

  // both pages of subscriptions collected
  assert.strictEqual(out.subscriptions.length, 2);
  assert.deepStrictEqual(out.subscriptions.map((s) => s.topic).sort(), ['alerts/+', 'factory/#']);

  // Basic auth header sent
  assert.match(auth, /^Basic /);
  assert.strictEqual(Buffer.from(auth.slice(6), 'base64').toString(), 'k:s');

  // cumulative traffic counters surfaced for rate derivation
  assert.deepStrictEqual(out.clients[0].counters, {
    msgsIn: 120,
    msgsOut: 45,
    bytesIn: 9000,
    bytesOut: 3000,
    connectedAt: '2026-07-13T00:00:00Z'
  });
});

// Fake HiveMQ Enterprise REST: cursor-paginated id list (absolute next link),
// then per-client detail + subscriptions.
function fakeHivemq({ captureAuth } = {}) {
  return async (url, opts) => {
    if (captureAuth) captureAuth(opts.headers.Authorization);
    const u = new URL(url);
    if (u.pathname === '/api/v1/mqtt/clients' && !u.searchParams.get('cursor')) {
      return json({
        items: [{ id: 'hive-1' }, { id: 'hive-2' }],
        _links: { next: 'http://h:8888/api/v1/mqtt/clients?cursor=abc&limit=500' }
      });
    }
    if (u.pathname === '/api/v1/mqtt/clients' && u.searchParams.get('cursor') === 'abc') {
      return json({ items: [{ id: 'hive-3' }], _links: {} });
    }
    if (u.pathname === '/api/v1/mqtt/clients/hive-1') {
      return json({ client: { id: 'hive-1', connected: true, connection: { sourceIp: '10.1.1.1', connectedAt: '2026-07-13T01:00:00Z' } } });
    }
    if (u.pathname === '/api/v1/mqtt/clients/hive-1/subscriptions') {
      return json({ items: [{ topicFilter: 'plant/#', qos: 'AT_LEAST_ONCE' }, { topicFilter: 'alerts/+', qos: 'AT_MOST_ONCE' }] });
    }
    if (/\/subscriptions$/.test(u.pathname)) return json({ items: [] });
    return json({ client: { connected: false } });
  };
}

test('HiveMQ backend follows cursors and fetches per-client subscriptions', async () => {
  let auth;
  const out = await fetchPubSub(
    { type: 'hivemq', url: 'http://h:8888', apiSecret: 'tok' },
    fakeHivemq({ captureAuth: (a) => (auth = a) })
  );
  assert.strictEqual(out.source, 'hivemq');
  assert.strictEqual(out.clients.length, 3); // both cursor pages
  const c1 = out.clients.find((c) => c.id === 'hive-1');
  assert.strictEqual(c1.ip, '10.1.1.1');
  assert.strictEqual(c1.subscriptionsCount, 2);
  // QoS names normalized to numbers
  const subs = out.subscriptions.filter((s) => s.clientId === 'hive-1');
  assert.deepStrictEqual(subs.map((s) => s.qos).sort(), [0, 1]);
  // bearer token sent
  assert.strictEqual(auth, 'Bearer tok');
});

test('unsupported admin type is rejected', async () => {
  await assert.rejects(() => fetchPubSub({ type: 'nope', url: 'http://x' }, async () => json({})), /unsupported admin type/);
});

test('non-OK admin response throws with status', async () => {
  const fetch500 = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  await assert.rejects(() => fetchPubSub({ type: 'emqx', url: 'http://h/api' }, fetch500), /401/);
});
