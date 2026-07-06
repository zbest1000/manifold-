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
      return json({ data: [{ clientid: 'sensor-1', username: 'u', ip_address: '10.0.0.5', connected: true, subscriptions_cnt: 2 }], meta: { hasnext: false } });
    }
    if (u.pathname.endsWith('/subscriptions')) {
      if (page === 1) return json({ data: [{ clientid: 'sensor-1', topic: 'factory/#', qos: 1 }], meta: { hasnext: true } });
      return json({ data: [{ clientid: 'sensor-1', topic: 'alerts/+', qos: 0 }], meta: { hasnext: false } });
    }
    return json({ data: [], meta: { hasnext: false } });
  };
}
const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

test('supportedTypes lists emqx', () => {
  assert.ok(supportedTypes().includes('emqx'));
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
});

test('unsupported admin type is rejected', async () => {
  await assert.rejects(() => fetchPubSub({ type: 'nope', url: 'http://x' }, async () => json({})), /unsupported admin type/);
});

test('non-OK admin response throws with status', async () => {
  const fetch500 = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  await assert.rejects(() => fetchPubSub({ type: 'emqx', url: 'http://h/api' }, fetch500), /401/);
});
