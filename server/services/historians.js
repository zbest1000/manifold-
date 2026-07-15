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
  // Numerics and strings go to DIFFERENT fields (`value` vs `raw`): InfluxDB
  // locks a field's type per shard, so a topic that alternates 21.5 / "error"
  // would otherwise get its writes rejected — and with store-and-forward those
  // rejects would spill and retry forever. Two fields make mixed topics legal.
  const lines = [];
  for (const p of points) {
    const num = typeof p.value === 'number' ? p.value : Number(p.value);
    const field = Number.isFinite(num)
      ? `value=${num}`
      : `raw="${escFieldString(typeof p.value === 'object' ? JSON.stringify(p.value) : p.value)}"`;
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
        max: 4,
        // Bounded waits: pg's defaults block FOREVER on an unreachable host,
        // which turns "database down" into a hung process (seen as CI jobs
        // spinning for hours). A write outage must surface as an error the
        // outbox can spill on, and idle pools must never pin the event loop.
        connectionTimeoutMillis: 10_000,
        query_timeout: 30_000,
        idleTimeoutMillis: 30_000,
        allowExitOnIdle: true
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

// ---- read-back (Trends) ------------------------------------------------------
//
// The write path above is one-way; these two calls close the loop so the UI can
// trend what Manifold recorded:
//   queryTags(conn, { search, limit })            -> string[] of topic names
//   querySeries(conn, { tags, start, end, maxPoints }) -> { series: [{ tag, points: [[tsMs, value], ...] }] }
// start/end are epoch ms (the route normalizes ISO input). Timebase has no
// generic read API surface we can target, so both calls reject with a clear
// message and the UI degrades to free-text tag entry / a hint.

/** Millisecond timestamp from epoch-ms number or ISO string. */
function toMillis(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return Date.parse(v);
}

function normalizeRange({ start, end, maxPoints = 1000 }) {
  const s = toMillis(start);
  const e = toMillis(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) throw new Error('start and end must be ISO timestamps or epoch milliseconds');
  if (e <= s) throw new Error('end must be after start');
  const mp = Math.round(Number(maxPoints));
  if (!Number.isFinite(mp) || mp < 10 || mp > 5000) throw new Error('maxPoints must be between 10 and 5000');
  return { start: s, end: e, maxPoints: mp };
}

/**
 * Quote a value for interpolation into a Flux script. Flux has no parameter
 * binding over the raw /query endpoint, so rather than attempt clever escaping
 * we REJECT values containing quote/backslash/newline — topic names never
 * legitimately contain them and a reject can't be out-escaped.
 */
function fluxString(value, what) {
  const s = String(value);
  if (/["\\\n\r]/.test(s)) throw new Error(`${what} must not contain quotes, backslashes, or newlines`);
  return `"${s}"`;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Parse InfluxDB annotated CSV into row objects keyed by column name.
 * `#`-prefixed annotation lines are skipped; a blank line ends a table so the
 * next non-blank line is a fresh header (multi-table responses).
 */
function parseFluxCsv(text) {
  const rows = [];
  let header = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) {
      header = null;
      continue;
    }
    if (line.startsWith('#')) continue;
    const cells = splitCsvLine(line);
    if (!header) {
      header = cells;
      continue;
    }
    const row = {};
    for (let i = 0; i < header.length; i++) if (header[i]) row[header[i]] = cells[i];
    rows.push(row);
  }
  return rows;
}

async function influxQuery(conn, flux, fetchImpl) {
  const base = String(conn.url || '').replace(/\/+$/, '');
  if (!base) throw new Error('influxdb url is required');
  const q = new URLSearchParams({ org: conn.org || '' });
  const res = await fetchImpl(`${base}/api/v2/query?${q}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.flux',
      Accept: 'application/csv',
      ...(conn.token ? { Authorization: `Token ${conn.token}` } : {})
    },
    body: flux
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`influxdb query failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return parseFluxCsv(await res.text());
}

async function influxQueryTags(conn, { search, limit }, fetchImpl) {
  const flux = `import "influxdata/influxdb/schema"\nschema.tagValues(bucket: ${fluxString(conn.bucket, 'bucket')}, tag: "topic", start: -30d)`;
  const rows = await influxQuery(conn, flux, fetchImpl);
  const needle = search.toLowerCase();
  const seen = new Set();
  for (const row of rows) {
    const v = row._value;
    if (v && (!needle || v.toLowerCase().includes(needle))) seen.add(v);
  }
  return [...seen].sort().slice(0, limit);
}

async function influxQuerySeries(conn, { tags, start, end, maxPoints }, fetchImpl) {
  const everySec = Math.max(1, Math.ceil((end - start) / 1000 / maxPoints));
  const topicFilter = tags.map((t) => `r.topic == ${fluxString(t, 'tag')}`).join(' or ');
  const flux = [
    `from(bucket: ${fluxString(conn.bucket, 'bucket')})`,
    `  |> range(start: ${new Date(start).toISOString()}, stop: ${new Date(end).toISOString()})`,
    `  |> filter(fn: (r) => r._measurement == ${fluxString(conn.measurement || 'manifold', 'measurement')} and r._field == "value")`,
    `  |> filter(fn: (r) => ${topicFilter})`,
    `  |> aggregateWindow(every: ${everySec}s, fn: mean, createEmpty: false)`,
    `  |> keep(columns: ["_time", "_value", "topic"])`
  ].join('\n');
  const rows = await influxQuery(conn, flux, fetchImpl);
  const byTag = new Map(tags.map((t) => [t, []]));
  for (const row of rows) {
    if (!byTag.has(row.topic) || !row._time || row._value === '' || row._value === undefined) continue;
    const ts = Date.parse(row._time);
    const value = Number(row._value);
    if (Number.isFinite(ts) && Number.isFinite(value)) byTag.get(row.topic).push([ts, value]);
  }
  return { series: tags.map((tag) => ({ tag, points: byTag.get(tag) })) };
}

async function timescaleQueryTags(conn, { search, limit }) {
  const table = safeIdent(conn.table || 'manifold_samples');
  const { pool } = pgEntryFor(conn);
  const { rows } = await pool.query(
    `SELECT DISTINCT topic FROM ${table} WHERE topic ILIKE $1 ORDER BY topic LIMIT $2`,
    [`%${search}%`, limit]
  );
  return rows.map((r) => r.topic);
}

async function timescaleQuerySeries(conn, { tags, start, end, maxPoints }) {
  const table = safeIdent(conn.table || 'manifold_samples');
  const { pool } = pgEntryFor(conn);
  // The bucket width is the ONLY interpolated value and it is built from an
  // integer we computed — user text never reaches the SQL string.
  const bucketSeconds = Math.max(1, Math.ceil((end - start) / 1000 / maxPoints));
  if (!Number.isSafeInteger(bucketSeconds)) throw new Error('invalid time range');
  const { rows } = await pool.query(
    `SELECT topic, time_bucket('${bucketSeconds} seconds'::interval, ts) AS bucket, avg(value) AS value
     FROM ${table}
     WHERE topic = ANY($1) AND ts BETWEEN $2 AND $3 AND value IS NOT NULL
     GROUP BY topic, bucket
     ORDER BY bucket`,
    [tags, new Date(start), new Date(end)]
  );
  const byTag = new Map(tags.map((t) => [t, []]));
  for (const row of rows) {
    if (!byTag.has(row.topic)) continue;
    const ts = row.bucket instanceof Date ? row.bucket.getTime() : Date.parse(row.bucket);
    const value = Number(row.value);
    if (Number.isFinite(ts) && Number.isFinite(value)) byTag.get(row.topic).push([ts, value]);
  }
  return { series: tags.map((tag) => ({ tag, points: byTag.get(tag) })) };
}

const TIMEBASE_TAGS_ERROR = 'tag listing not supported for timebase — enter the tag path directly';
const TIMEBASE_QUERY_ERROR = 'trend read-back not supported for timebase — use the Timebase Explorer to view this data';

const TAG_QUERY_BACKENDS = {
  influxdb: influxQueryTags,
  timescaledb: timescaleQueryTags,
  timebase: () => {
    throw new Error(TIMEBASE_TAGS_ERROR);
  }
};

const SERIES_QUERY_BACKENDS = {
  influxdb: influxQuerySeries,
  timescaledb: timescaleQuerySeries,
  timebase: () => {
    throw new Error(TIMEBASE_QUERY_ERROR);
  }
};

/** List distinct topic/tag names stored in a historian. */
async function queryTags(conn = {}, { search = '', limit = 100 } = {}, fetchImpl = globalThis.fetch) {
  const backend = TAG_QUERY_BACKENDS[conn.type];
  if (!backend) throw new Error(`unsupported historian type "${conn.type}" (supported: ${Object.keys(BACKENDS).join(', ')})`);
  const lim = Math.min(1000, Math.max(1, Math.round(Number(limit) || 100)));
  return backend(conn, { search: String(search), limit: lim }, fetchImpl);
}

/** Read downsampled series for up to 10 tags over a time range. */
async function querySeries(conn = {}, { tags = [], start, end, maxPoints = 1000 } = {}, fetchImpl = globalThis.fetch) {
  const backend = SERIES_QUERY_BACKENDS[conn.type];
  if (!backend) throw new Error(`unsupported historian type "${conn.type}" (supported: ${Object.keys(BACKENDS).join(', ')})`);
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > 10 || tags.some((t) => typeof t !== 'string' || !t.trim())) {
    throw new Error('tags must be an array of 1-10 non-empty strings');
  }
  const range = normalizeRange({ start, end, maxPoints });
  return backend(conn, { tags, ...range }, fetchImpl);
}

/** Close pooled Postgres connections (shutdown). */
async function closePools() {
  for (const { pool } of pgPools.values()) await pool.end().catch(() => {});
  pgPools.clear();
}

const BACKENDS = { influxdb: influxWrite, timebase: timebaseWrite, timescaledb: timescaleWrite };

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

module.exports = { writePoints, queryTags, querySeries, supportedTypes, publicConfig, toLineProtocol, closePools, DEFAULT_TIMEBASE_PATH };
