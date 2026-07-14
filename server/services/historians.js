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
 * - `timescaledb`: TimescaleDB (or plain PostgreSQL) over the `pg` driver.
 *   Batched multi-row inserts into a samples table (created on first write:
 *   ts timestamptz, topic text, value double precision, raw text, quality
 *   smallint, indexed by (topic, ts DESC)). On TimescaleDB the table is
 *   promoted to a hypertable via `create_hypertable(..., if_not_exists)`;
 *   on plain Postgres that call fails harmlessly and the table still works.
 *   Config: { type:'timescaledb', host, port?, database, user, password?,
 *   ssl?, table? }.
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

// ---- TimescaleDB / PostgreSQL ------------------------------------------------

let PgPool = null; // lazy — the pg driver only loads if a timescaledb historian exists
const pgPools = new Map(); // cache key -> { pool, schemaReady: Set(table) }

function safeIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) throw new Error(`invalid table name "${name}"`);
  return name;
}

function pgEntryFor(conn) {
  if (conn.__pool) return { pool: conn.__pool, schemaReady: conn.__schemaReady || new Set() }; // test injection
  if (!PgPool) PgPool = require('pg').Pool;
  const key = JSON.stringify([conn.host, conn.port, conn.database, conn.user, Boolean(conn.ssl)]);
  let entry = pgPools.get(key);
  if (!entry) {
    entry = {
      pool: new PgPool({
        host: conn.host,
        port: Number(conn.port) || 5432,
        database: conn.database,
        user: conn.user,
        password: conn.password || undefined,
        ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
        max: 4
      }),
      schemaReady: new Set()
    };
    pgPools.set(key, entry);
  }
  return entry;
}

async function timescaleWrite(conn, points) {
  if (!conn.host || !conn.database || !conn.user) throw new Error('timescaledb needs host, database, and user');
  const table = safeIdent(conn.table || 'manifold_samples');
  const { pool, schemaReady } = pgEntryFor(conn);

  if (!schemaReady.has(table)) {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${table} (
         ts timestamptz NOT NULL,
         topic text NOT NULL,
         value double precision,
         raw text,
         quality smallint
       )`
    );
    await pool.query(`CREATE INDEX IF NOT EXISTS ${table}_topic_ts ON ${table} (topic, ts DESC)`);
    try {
      // TimescaleDB promotion; on plain Postgres the function doesn't exist —
      // the table still works, just without hypertable chunking.
      await pool.query(`SELECT create_hypertable('${table}', 'ts', if_not_exists => TRUE)`);
    } catch {
      // not a Timescale instance — fine
    }
    schemaReady.add(table);
  }

  // One multi-row parameterized INSERT per batch.
  const params = [];
  const rows = points.map((p, i) => {
    const base = i * 5;
    const num = typeof p.value === 'number' ? p.value : Number(p.value);
    params.push(
      new Date(p.ts),
      p.tag,
      Number.isFinite(num) ? num : null,
      typeof p.value === 'object' ? JSON.stringify(p.value) : String(p.value),
      p.quality ?? 192
    );
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`;
  });
  await pool.query(`INSERT INTO ${table} (ts, topic, value, raw, quality) VALUES ${rows.join(',')}`, params);
  return { written: points.length };
}

/** Close pooled Postgres connections (shutdown). */
async function closePools() {
  for (const { pool } of pgPools.values()) await pool.end().catch(() => {});
  pgPools.clear();
}

const BACKENDS = { influxdb: influxWrite, timebase: timebaseWrite, timescaledb: timescaleWrite, 'timebase-ce': timebaseCeWrite };

async function writePoints(conn = {}, points = [], fetchImpl = globalThis.fetch) {
  const backend = BACKENDS[conn.type];
  if (!backend) throw new Error(`unsupported historian type "${conn.type}" (supported: ${Object.keys(BACKENDS).join(', ')})`);
  // timescaledb talks Postgres, not HTTP — only the HTTP backends need fetch
  if (conn.type !== 'timescaledb' && typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
  if (!points.length) return { written: 0 };
  return backend(conn, points, fetchImpl);
}

function supportedTypes() {
  return Object.keys(BACKENDS);
}

/** Redact secrets for API responses. */
function publicConfig(conn) {
  const { token, apiKey, apiSecret, password, ...rest } = conn;
  return { ...rest, hasSecret: Boolean(token || apiKey || apiSecret || password) };
}

module.exports = { writePoints, supportedTypes, publicConfig, toLineProtocol, closePools, DEFAULT_TIMEBASE_PATH };
