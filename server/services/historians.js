'use strict';

/**
 * Historian integrations — time-series targets for pipelines and the recorder.
 *
 * Backends normalize to one write call:
 *   writePoints(conn, points)  with  points: [{ tag, ts, value, quality? }]
 * where `tag` is the (possibly re-pathed) topic, `ts` is epoch ms, and `value`
 * is whatever the transform chain produced (numbers become proper numeric
 * fields; everything else is stringified).
 *
 * - `influxdb`: InfluxDB v2 line-protocol write
 *   (POST {url}/api/v2/write?org=&bucket=&precision=ms, `Authorization: Token`).
 *   Config: { type:'influxdb', url, org, bucket, token, measurement? }.
 * - `timebase-ce`: FINOS TimeBase CE via the TimebaseWS web gateway
 *   (github.com/epam/TimebaseWS, default port 8099). Messages POST to
 *   `/api/v0/{stream}/write` as JSON rows { $type, symbol, timestamp, ... };
 *   the path is overridable (`writePath`) because gateway versions differ —
 *   confirm on your instance's Swagger at `/api/v0/docs`. Auth: none (common
 *   for CE quickstarts) or Deltix API-key signing (X-Deltix-ApiKey +
 *   X-Deltix-Signature = Base64(HmacSHA384(method+path+query+body, secret))).
 *   Config: { type:'timebase-ce', url, stream, messageType?, writePath?,
 *   apiKey?, apiSecret? }.
 * - `timebase`: Timebase historian (Flow Software) public REST API — TVQ
 *   writes into a dataset (datasets auto-create on first write; the historian
 *   ignores TVQs older than a tag's newest point). Default endpoint follows
 *   the public REST API on :4511; the exact path is confirmable on any
 *   instance's own Swagger at `http://<host>:4511/api/help`, and `writePath`
 *   overrides it if a version differs. Config: { type:'timebase', url,
 *   dataset, writePath?, apiKey? }.
 *   NOTE: Timebase also ingests MQTT/Sparkplug natively — pointing its MQTT
 *   collector at your broker (or at a Manifold pipeline's output namespace)
 *   is an equally supported, often simpler path.
 */

const DEFAULT_TIMEBASE_PATH = '/api/tags/data';

// ---- line protocol helpers (InfluxDB) ---------------------------------------

function escMeasurement(s) {
  return String(s).replace(/([, ])/g, '\\$1');
}

function escTag(s) {
  return String(s).replace(/([,= ])/g, '\\$1');
}

function escFieldString(s) {
  return String(s).replace(/(["\\])/g, '\\$1');
}

function toLineProtocol(points, measurement) {
  const lines = [];
  for (const p of points) {
    const num = typeof p.value === 'number' ? p.value : Number(p.value);
    const field = Number.isFinite(num)
      ? `value=${num}`
      : `value="${escFieldString(typeof p.value === 'object' ? JSON.stringify(p.value) : p.value)}"`;
    lines.push(`${escMeasurement(measurement)},topic=${escTag(p.tag)} ${field} ${Math.round(p.ts)}`);
  }
  return lines.join('\n');
}

async function influxWrite(conn, points, fetchImpl) {
  const base = String(conn.url || '').replace(/\/+$/, '');
  if (!base) throw new Error('influxdb url is required');
  const q = new URLSearchParams({ org: conn.org || '', bucket: conn.bucket || '', precision: 'ms' });
  const res = await fetchImpl(`${base}/api/v2/write?${q}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...(conn.token ? { Authorization: `Token ${conn.token}` } : {})
    },
    body: toLineProtocol(points, conn.measurement || 'manifold')
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`influxdb write failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return { written: points.length };
}

// ---- Timebase (TVQ into a dataset) ------------------------------------------

async function timebaseWrite(conn, points, fetchImpl) {
  const base = String(conn.url || '').replace(/\/+$/, '');
  if (!base) throw new Error('timebase url is required');
  if (!conn.dataset) throw new Error('timebase dataset is required');

  // Group points per tag: one entry per tag with its TVQ array.
  const byTag = new Map();
  for (const p of points) {
    if (!byTag.has(p.tag)) byTag.set(p.tag, []);
    byTag.get(p.tag).push({
      t: new Date(p.ts).toISOString(),
      v: typeof p.value === 'object' ? JSON.stringify(p.value) : p.value,
      q: p.quality ?? 192 // OPC "good"
    });
  }
  const body = {
    dataset: conn.dataset,
    tags: [...byTag.entries()].map(([n, data]) => ({ n, data }))
  };

  const path = conn.writePath || DEFAULT_TIMEBASE_PATH;
  const res = await fetchImpl(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {})
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`timebase write failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return { written: points.length };
}

// ---- FINOS TimeBase CE (TimebaseWS gateway) ----------------------------------

const crypto = require('crypto');

function deltixHeaders(conn, method, pathWithQuery, body) {
  if (!conn.apiKey) return {};
  // Payload per TimebaseWS api-keys guide: method + path + query + body.
  const signature = crypto
    .createHmac('sha384', conn.apiSecret || '')
    .update(`${method.toUpperCase()}${pathWithQuery}${body}`)
    .digest('base64');
  return { 'X-Deltix-ApiKey': conn.apiKey, 'X-Deltix-Signature': signature };
}

async function timebaseCeWrite(conn, points, fetchImpl) {
  const base = String(conn.url || '').replace(/\/+$/, '');
  if (!base) throw new Error('timebase-ce url is required');
  if (!conn.stream) throw new Error('timebase-ce stream is required');

  const path = conn.writePath || `/api/v0/${encodeURIComponent(conn.stream)}/write`;
  const $type = conn.messageType || 'ManifoldSample';
  const body = JSON.stringify(
    points.map((p) => ({
      $type,
      symbol: p.tag,
      timestamp: new Date(p.ts).toISOString(),
      value: typeof p.value === 'number' ? p.value : Number(p.value),
      raw: typeof p.value === 'object' ? JSON.stringify(p.value) : String(p.value),
      quality: p.quality ?? 192
    }))
  );

  const res = await fetchImpl(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...deltixHeaders(conn, 'POST', path, body)
    },
    body
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`timebase-ce write failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return { written: points.length };
}

const BACKENDS = { influxdb: influxWrite, timebase: timebaseWrite, 'timebase-ce': timebaseCeWrite };

async function writePoints(conn = {}, points = [], fetchImpl = globalThis.fetch) {
  const backend = BACKENDS[conn.type];
  if (!backend) throw new Error(`unsupported historian type "${conn.type}" (supported: ${Object.keys(BACKENDS).join(', ')})`);
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
  if (!points.length) return { written: 0 };
  return backend(conn, points, fetchImpl);
}

function supportedTypes() {
  return Object.keys(BACKENDS);
}

/** Redact secrets for API responses. */
function publicConfig(conn) {
  const { token, apiKey, apiSecret, ...rest } = conn;
  return { ...rest, hasSecret: Boolean(token || apiKey || apiSecret) };
}

module.exports = { writePoints, supportedTypes, publicConfig, toLineProtocol, DEFAULT_TIMEBASE_PATH };
