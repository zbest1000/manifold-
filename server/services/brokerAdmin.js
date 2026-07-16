'use strict';

const { guardedFetch } = require('./egressGuard');

// Admin APIs get a hard per-request deadline so a wedged broker admin
// endpoint can't hang the Flows view indefinitely, and go through the egress
// guard so a user-supplied admin URL can't be aimed at internal/metadata hosts.
const defaultFetch = (url, opts) => guardedFetch(url, opts, 10_000);

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
 * Supported backends:
 * - `emqx`: EMQX v5 REST (/clients + /subscriptions, page/limit pagination).
 * - `hivemq`: HiveMQ Enterprise REST API (/api/v1/mqtt/clients cursor-paginated,
 *   then per-client /subscriptions — so client count is capped harder here).
 *
 * Mosquitto is deliberately NOT a backend: it has no admin API that lists
 * per-client subscriptions. `mosquitto_ctrl`/the dynamic-security plugin manage
 * accounts and ACLs but cannot enumerate live subscriptions, and `$SYS` only
 * publishes aggregate counts. There is nothing to integrate against — for
 * mosquitto the wildcard-resolution engine (Flows) is the honest ceiling.
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
    subscriptionsCount: c.subscriptions_cnt ?? c.subscriptions ?? 0,
    // Cumulative traffic counters (EMQX exposes them per client). Consumers can
    // diff two snapshots to derive live per-client message/byte rates.
    counters: {
      msgsIn: c.recv_msg ?? null,
      msgsOut: c.send_msg ?? null,
      bytesIn: c.recv_oct ?? null,
      bytesOut: c.send_oct ?? null,
      connectedAt: c.connected_at ?? null
    }
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

const HIVEMQ_CLIENT_CAP = 500; // per-client subscription fetch => keep the fan-out sane

/**
 * HiveMQ Enterprise REST backend. `config`: { url, apiSecret? (bearer token) }.
 * HiveMQ's client list is cursor-paginated and returns ids only; subscriptions
 * require one call per client, so the client count is capped at
 * HIVEMQ_CLIENT_CAP (reported via `truncated`).
 */
async function hivemqPubSub(config, fetchImpl) {
  const baseUrl = String(config.url || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('admin url is required');
  const token = config.apiSecret || config.apiKey || '';
  const headers = {
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
  const get = async (path) => {
    const res = await fetchImpl(`${baseUrl}${path}`, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`admin API ${path} failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return res.json();
  };

  // 1) Enumerate client ids (cursor pagination via _links.next).
  const ids = [];
  let truncated = false;
  let next = '/api/v1/mqtt/clients?limit=500';
  while (next) {
    const body = await get(next);
    for (const item of body.items || []) {
      if (ids.length >= HIVEMQ_CLIENT_CAP) {
        truncated = true;
        break;
      }
      ids.push(item.id);
    }
    if (truncated) break;
    // _links.next may be absolute or relative; normalize to a path.
    const link = body._links?.next || null;
    next = link ? link.replace(/^https?:\/\/[^/]+/, '') : null;
  }

  // 2) Per-client detail + subscriptions (small bounded concurrency).
  const clients = [];
  const subscriptions = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (id) => {
        const enc = encodeURIComponent(id);
        const [detail, subs] = await Promise.all([
          get(`/api/v1/mqtt/clients/${enc}`).catch(() => null),
          get(`/api/v1/mqtt/clients/${enc}/subscriptions`).catch(() => null)
        ]);
        const c = detail?.client || {};
        const subItems = subs?.items || [];
        clients.push({
          id,
          username: c.username || null,
          ip: c.connection?.sourceIp || null,
          connected: c.connected !== false,
          subscriptionsCount: subItems.length,
          counters: {
            msgsIn: null, // HiveMQ's REST API does not expose per-client traffic counters
            msgsOut: null,
            bytesIn: null,
            bytesOut: null,
            connectedAt: c.connection?.connectedAt ?? null
          }
        });
        for (const s of subItems) {
          subscriptions.push({ clientId: id, topic: s.topicFilter, qos: s.qos === 'AT_LEAST_ONCE' ? 1 : s.qos === 'EXACTLY_ONCE' ? 2 : Number(s.qos) || 0 });
        }
      })
    );
  }

  return { source: 'hivemq', clients, subscriptions, truncated };
}

const BACKENDS = { emqx: emqxPubSub, hivemq: hivemqPubSub };

/** Fetch normalized pub/sub topology from a broker admin API. */
async function fetchPubSub(config = {}, fetchImpl = defaultFetch) {
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
