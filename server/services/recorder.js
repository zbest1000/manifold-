'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { matchParts, compiledView } = require('./mqttMatch');

/**
 * Recorder — historian-lite time-series capture. A recording watches one
 * broker + filter on the coalesced message tap and appends every matching
 * message to an append-only JSONL file in the data dir (or forwards to a
 * historian via the store-and-forward outbox). Files are the replay source.
 *
 * Hot-path discipline: recording configs are compiled (filters pre-split) and
 * rebuilt only when the profile store's revision changes, and file appends go
 * through per-recording WriteStreams — Node buffers and flushes off the event
 * loop, instead of a synchronous disk write per message.
 *
 * Line format: {"t":<epoch ms>,"topic":"...","v":<payload>,"q":<qos>}
 */

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const READ_LIMIT_MAX = 5000;

// Reduce a chronological [[ts, value], ...] series to at most `cap` points by
// keeping the last value in each of `cap` equal time buckets — a cheap,
// order-preserving downsample for charting long recordings.
function downsampleLastPerBucket(points, cap) {
  if (points.length <= cap) return points;
  const first = points[0][0];
  const span = points[points.length - 1][0] - first || 1;
  const width = span / cap;
  const out = [];
  let bucket = -1;
  let last = null;
  for (const pt of points) {
    const idx = Math.min(cap - 1, Math.floor((pt[0] - first) / width));
    if (idx !== bucket && last) out.push(last);
    bucket = idx;
    last = pt;
  }
  if (last) out.push(last);
  return out;
}

class Recorder {
  constructor({ mqttManager, profiles, outbox = null, dir = process.env.MANIFOLD_DATA_DIR || path.join(__dirname, '..', 'data') }) {
    this.manager = mqttManager;
    this.profiles = profiles;
    this.outbox = outbox;
    this.dir = path.join(dir, 'recordings');
    this.status = new Map(); // recordingId -> { points, bytes, full, lastTs, lastError }
    this.streams = new Map(); // recordingId -> WriteStream
    this.onMessage = this.onMessage.bind(this);
    this.started = false;
    this.table = compiledView(profiles, () =>
      this.profiles
        .listIn('recordings')
        .filter((r) => r.enabled !== false && r.brokerId && r.filter)
        .map((r) => ({ rec: r, parts: String(r.filter).split('/') }))
    );
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.manager.on('message', this.onMessage);
  }

  stop() {
    this.manager.off('message', this.onMessage);
    for (const [, stream] of this.streams) stream.end();
    this.streams.clear();
    this.started = false;
  }

  filePath(id) {
    // ids are uuids from our own routes; keep path handling defensive anyway
    return path.join(this.dir, `${String(id).replace(/[^a-zA-Z0-9-]/g, '')}.jsonl`);
  }

  _status(id) {
    let s = this.status.get(id);
    if (!s) {
      s = { points: 0, bytes: 0, full: false, lastTs: 0, lastError: null };
      try {
        s.bytes = fs.statSync(this.filePath(id)).size;
      } catch {
        // no file yet
      }
      this.status.set(id, s);
    }
    return s;
  }

  _stream(id) {
    let stream = this.streams.get(id);
    if (!stream) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      stream = fs.createWriteStream(this.filePath(id), { flags: 'a', mode: 0o600 });
      stream.on('error', (error) => {
        this._status(id).lastError = error.message;
      });
      this.streams.set(id, stream);
    }
    return stream;
  }

  onMessage(msg) {
    const table = this.table();
    if (!table.length) return;
    const topicParts = msg.topicParts || msg.topic.split('/');

    for (const { rec, parts } of table) {
      if (rec.brokerId !== msg.brokerId) continue;
      if (!matchParts(parts, topicParts)) continue;
      const s = this._status(rec.id);
      const ts = new Date(msg.timestamp).getTime() || Date.now();

      if (rec.target?.type === 'historian') {
        this.outbox?.enqueue(rec.target.historianId, [{ tag: msg.topic, ts, value: msg.payload, quality: 192 }]);
        s.points++;
        s.lastTs = ts;
        continue;
      }

      // file target — buffered async append via the recording's WriteStream
      if (s.full) continue;
      const cap = Number(rec.maxBytes) > 0 ? Number(rec.maxBytes) : DEFAULT_MAX_BYTES;
      const line = JSON.stringify({ t: ts, topic: msg.topic, v: msg.payload, q: msg.qos }) + '\n';
      if (s.bytes + line.length > cap) {
        s.full = true;
        s.lastError = 'file cap reached — recording stopped';
        continue;
      }
      this._stream(rec.id).write(line);
      s.bytes += line.length;
      s.points++;
      s.lastTs = ts;
    }
  }

  /** Flush buffered writes so a file is complete on disk (replay, shutdown). */
  async sync(id = null) {
    const targets = id ? [this.streams.get(id)].filter(Boolean) : [...this.streams.values()];
    await Promise.all(
      targets.map(
        (stream) =>
          new Promise((resolve) => {
            if (stream.writableLength === 0) return resolve();
            stream.write('', () => resolve());
          })
      )
    );
  }

  /** Read back a bounded slice of a file recording (newest last). */
  async read(id, { topic = null, from = 0, to = Infinity, limit = 500 } = {}) {
    await this.sync(id);
    const cap = Math.min(Number(limit) || 500, READ_LIMIT_MAX);
    const file = this.filePath(id);
    if (!fs.existsSync(file)) return { points: [], total: 0 };
    const out = [];
    let total = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let p;
      try {
        p = JSON.parse(line);
      } catch {
        continue;
      }
      if (p.t < from || p.t > to) continue;
      if (topic && p.topic !== topic) continue;
      total++;
      out.push(p);
      if (out.length > cap) out.shift(); // keep the newest `cap` in range
    }
    return { points: out, total, truncated: total > out.length };
  }

  /**
   * Downsampled multi-tag numeric series over a file recording, shaped exactly
   * like historians.querySeries ({ series: [{ tag, points: [[tsMs, value]] }] })
   * so the Trends UI can chart a recording without any external database. Only
   * numeric values chart; each tag is bucketed to at most maxPoints (last value
   * per time bucket).
   */
  async series(id, { tags = [], from = 0, to = Infinity, maxPoints = 1000 } = {}) {
    await this.sync(id);
    const file = this.filePath(id);
    if (!fs.existsSync(file)) return { series: [] };
    const wanted = new Set(tags);
    const byTag = new Map(); // topic -> [[tsMs, value]] in chronological order
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let p;
      try {
        p = JSON.parse(line);
      } catch {
        continue;
      }
      if (wanted.size && !wanted.has(p.topic)) continue;
      if (p.t < from || p.t > to) continue;
      const num = typeof p.v === 'number' ? p.v : Number(p.v);
      if (!Number.isFinite(num)) continue; // only numeric points chart
      if (!byTag.has(p.topic)) byTag.set(p.topic, []);
      byTag.get(p.topic).push([p.t, num]);
    }
    const cap = Math.min(Math.max(Number(maxPoints) || 1000, 1), READ_LIMIT_MAX);
    const series = [];
    for (const [tag, points] of byTag) series.push({ tag, points: downsampleLastPerBucket(points, cap) });
    return { series };
  }

  remove(id) {
    const stream = this.streams.get(id);
    if (stream) {
      stream.end();
      this.streams.delete(id);
    }
    this.status.delete(id);
    try {
      fs.unlinkSync(this.filePath(id));
    } catch {
      // no file — fine
    }
  }

  getStatus(id) {
    return this._status(id);
  }
}

module.exports = Recorder;
