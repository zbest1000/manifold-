'use strict';

/**
 * Broker admin integration — the only honest source for "who subscribes to what".
 *
 * MQTT itself and the `$SYS` tree expose only aggregate counts, never a per-client
 * subscription map. Brokers that DO expose it do so through an admin API. This
 * module talks to those APIs and normalizes the result into a common shape:
 *
 *   { source, clients: [{ id, username, ip, connected, subscriptionsCount }],
 *     subscriptions: [{ clientId, topic, qos }], truncated }
 *
 * EMQX v5 (open-source) REST is supported first — it exposes /clients and
 * /subscriptions. The shape is deliberately broker-agnostic so HiveMQ /
 * mosquitto_ctrl backends can be added later behind the same `type` switch.
 */

const MAX_ROWS = 20000; // safety cap across paginated fetches
const PAGE = 1000;

function basicAuth(key, secret) {
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}

async function fetchAllPages(baseUrl, pathName, headers, fetchImpl, mapRow) {
  const rows = [];
  let page = 1;
  let truncated = false;
  // EMQX paginates with ?page=&limit= and returns meta.hasnext.
  for (;;) {
    const url = `${baseUrl}/${pathName}?page=${page}&limit=${PAGE}`;
    const res = await fetchImpl(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`admin API ${pathName} failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const body = await res.json();
    const data = Array.isArray(body) ? body : body.data || [];
    for (const row of data) {
      rows.push(mapRow(row));
      if (rows.length >= MAX_ROWS) {
        truncated = true;
        break;
      }
    }
    const hasNext = body?.meta?.hasnext === true && !truncated && data.length > 0;
    if (!hasNext) break;
    page += 1;
  }
  return { rows, truncated };
}

/** EMQX v5 REST backend. `config`: { url, apiKey, apiSecret }. */
async function emqxPubSub(config, fetchImpl) {
  const baseUrl = String(config.url || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('admin url is required');
  const headers = {
    Accept: 'application/json',
    ...(config.apiKey ? { Authorization: basicAuth(config.apiKey, config.apiSecret || '') } : {})
  };

  const clientsRes = await fetchAllPages(baseUrl, 'clients', headers, fetchImpl, (c) => ({
    id: c.clientid,
    username: c.username || null,
    ip: c.ip_address || null,
    connected: c.connected !== false,
    subscriptionsCount: c.subscriptions_cnt ?? c.subscriptions ?? 0
  }));
  const subsRes = await fetchAllPages(baseUrl, 'subscriptions', headers, fetchImpl, (s) => ({
    clientId: s.clientid,
    topic: s.topic,
    qos: s.qos ?? 0
  }));

  return {
    source: 'emqx',
    clients: clientsRes.rows,
    subscriptions: subsRes.rows,
    truncated: clientsRes.truncated || subsRes.truncated
  };
}

const BACKENDS = { emqx: emqxPubSub };

/** Fetch normalized pub/sub topology from a broker admin API. */
async function fetchPubSub(config = {}, fetchImpl = globalThis.fetch) {
  const type = String(config.type || 'emqx');
  const backend = BACKENDS[type];
  if (!backend) throw new Error(`unsupported admin type "${type}" (supported: ${Object.keys(BACKENDS).join(', ')})`);
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
  return backend(config, fetchImpl);
}

function supportedTypes() {
  return Object.keys(BACKENDS);
}

module.exports = { fetchPubSub, supportedTypes, MAX_ROWS };
