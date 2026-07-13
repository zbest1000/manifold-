'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { matchFilter } = require('./mqttMatch');
const historians = require('./historians');

/**
 * Recorder — historian-lite time-series capture. A recording watches one
 * broker + filter on the coalesced message tap and appends every matching
 * message to an append-only JSONL file in the data dir (or forwards to a
 * configured historian). Files are the replay source too.
 *
 * Line format: {"t":<epoch ms>,"topic":"...","v":<payload>,"q":<qos>}
 *
 * Recording shape (profile store `recordings`):
 *   { id, name, brokerId, filter, enabled,
 *     target: { type:'file' } | { type:'historian', historianId },
 *     maxBytes? (file cap, default 50 MB — recording stops at the cap) }
 */

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const HISTORIAN_FLUSH_MS = 2000;
const READ_LIMIT_MAX = 5000;

class Recorder {
  constructor({ mqttManager, profiles, dir = process.env.TC_DATA_DIR || path.join(__dirname, '..', 'data'), fetchImpl = globalThis.fetch }) {
    this.manager = mqttManager;
    this.profiles = profiles;
    this.dir = path.join(dir, 'recordings');
    this.fetchImpl = fetchImpl;
    this.status = new Map(); // recordingId -> { points, bytes, full, lastTs, lastError }
    this.buffers = new Map(); // historianId -> points[]
    this.onMessage = this.onMessage.bind(this);
    this.flushTimer = null;
  }

  start() {
    if (this.flushTimer) return;
    this.manager.on('message', this.onMessage);
    this.flushTimer = setInterval(() => this.flushHistorians(), HISTORIAN_FLUSH_MS);
    this.flushTimer.unref?.();
  }

  stop() {
    this.manager.off('message', this.onMessage);
    clearInterval(this.flushTimer);
    this.flushTimer = null;
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
        const st = fs.statSync(this.filePath(id));
        s.bytes = st.size;
      } catch {
        // no file yet
      }
      this.status.set(id, s);
    }
    return s;
  }

  onMessage(msg) {
    for (const rec of this.profiles.listIn('recordings')) {
      if (rec.enabled === false) continue;
      if (rec.brokerId !== msg.brokerId) continue;
      if (!matchFilter(rec.filter, msg.topic)) continue;
      const s = this._status(rec.id);
      const ts = new Date(msg.timestamp).getTime() || Date.now();

      if (rec.target?.type === 'historian') {
        let buf = this.buffers.get(rec.target.historianId);
        if (!buf) {
          buf = [];
          this.buffers.set(rec.target.historianId, buf);
        }
        if (buf.length < 5000) {
          buf.push({ tag: msg.topic, ts, value: msg.payload });
          s.points++;
          s.lastTs = ts;
        } else {
          s.lastError = 'historian buffer full';
        }
        continue;
      }

      // file target
      if (s.full) continue;
      const cap = Number(rec.maxBytes) > 0 ? Number(rec.maxBytes) : DEFAULT_MAX_BYTES;
      const line = JSON.stringify({ t: ts, topic: msg.topic, v: msg.payload, q: msg.qos }) + '\n';
      if (s.bytes + line.length > cap) {
        s.full = true;
        s.lastError = 'file cap reached — recording stopped';
        continue;
      }
      try {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        fs.appendFileSync(this.filePath(rec.id), line, { mode: 0o600 });
        s.bytes += line.length;
        s.points++;
        s.lastTs = ts;
      } catch (error) {
        s.lastError = error.message;
      }
    }
  }

  async flushHistorians() {
    for (const [historianId, buf] of this.buffers) {
      if (!buf.length) continue;
      const conn = this.profiles.getIn('historians', historianId);
      const points = buf.splice(0, buf.length);
      if (!conn) continue;
      try {
        await historians.writePoints(conn, points, this.fetchImpl);
      } catch (error) {
        // surfaced on every recording pointing at this historian
        for (const rec of this.profiles.listIn('recordings')) {
          if (rec.target?.historianId === historianId) this._status(rec.id).lastError = error.message;
        }
      }
    }
  }

  /** Read back a bounded slice of a file recording (newest last). */
  async read(id, { topic = null, from = 0, to = Infinity, limit = 500 } = {}) {
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

  remove(id) {
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
