'use strict';

const fs = require('fs');
const path = require('path');
const historians = require('./historians');

/**
 * Historian outbox — store-and-forward for time-series writes.
 *
 * Every point destined for a historian goes through here. In-memory queues
 * flush on an interval; when a write FAILS, the batch spills to an append-only
 * JSONL file per historian (survives restarts) and is drained back — oldest
 * first, ahead of new traffic — once writes succeed again. This is the
 * industry-standard behavior (HighByte, Ignition store-and-forward): a
 * historian outage delays data, it doesn't delete it.
 *
 * Bounds are explicit and reported, never silent: the memory queue caps at
 * MEM_MAX (overflow spills to disk immediately), the spill file caps at
 * SPILL_MAX_BYTES (beyond it, oldest data is already on disk and NEW points
 * are dropped and counted — the one honest option left).
 */

const FLUSH_MS = 2000;
const MEM_MAX = 5000;
const BATCH = 1000;
const SPILL_MAX_BYTES = 20 * 1024 * 1024;

class HistorianOutbox {
  constructor({ profiles, dir = process.env.MANIFOLD_DATA_DIR || path.join(__dirname, '..', 'data'), fetchImpl = globalThis.fetch, spillMaxBytes = SPILL_MAX_BYTES }) {
    this.profiles = profiles;
    this.dir = path.join(dir, 'outbox');
    this.fetchImpl = fetchImpl;
    this.spillMaxBytes = spillMaxBytes;
    this.queues = new Map(); // historianId -> points[]
    this.stats = new Map(); // historianId -> { written, spilled, drained, dropped, lastError, lastWrite }
    this.timer = null;
    this.flushing = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  _stat(id) {
    let s = this.stats.get(id);
    if (!s) {
      s = { written: 0, spilled: 0, drained: 0, dropped: 0, lastError: null, lastWrite: 0 };
      this.stats.set(id, s);
    }
    return s;
  }

  spillPath(id) {
    return path.join(this.dir, `${String(id).replace(/[^a-zA-Z0-9-]/g, '')}.jsonl`);
  }

  enqueue(historianId, points) {
    if (!points.length) return;
    let q = this.queues.get(historianId);
    if (!q) {
      q = [];
      this.queues.set(historianId, q);
    }
    q.push(...points);
    // Memory bound: overflow goes straight to disk rather than being dropped.
    if (q.length > MEM_MAX) this._spill(historianId, q.splice(0, q.length - MEM_MAX));
  }

  _spill(id, points) {
    if (!points.length) return;
    const s = this._stat(id);
    const file = this.spillPath(id);
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        // no spill yet
      }
      const lines = points.map((p) => JSON.stringify(p)).join('\n') + '\n';
      if (size + lines.length > this.spillMaxBytes) {
        // At the cap something must go; which end is a per-historian choice.
        // 'oldest' (keep newest — what most historians want: recent data is
        // most valuable) rewrites the file head; default keeps the outage's
        // beginning and drops incoming. Either way the count is reported.
        const conn = this.profiles.getIn('historians', id);
        if (conn?.dropPolicy === 'oldest') {
          const raw = fs.readFileSync(file, 'utf8');
          const needed = size + lines.length - this.spillMaxBytes;
          let cut = 0;
          let droppedOld = 0;
          while (cut < needed && cut < raw.length) {
            const nl = raw.indexOf('\n', cut);
            if (nl === -1) {
              cut = raw.length;
            } else {
              cut = nl + 1;
            }
            droppedOld++;
          }
          fs.writeFileSync(file, raw.slice(cut) + lines, { mode: 0o600 });
          s.spilled += points.length;
          s.dropped += droppedOld;
          s.lastError = `spill cap: dropped ${droppedOld} oldest point(s) to keep newest`;
        } else {
          s.dropped += points.length;
          s.lastError = `spill cap reached (${this.spillMaxBytes} bytes) — dropping new points`;
        }
        return;
      }
      fs.appendFileSync(file, lines, { mode: 0o600 });
      s.spilled += points.length;
    } catch (error) {
      s.dropped += points.length;
      s.lastError = `spill failed: ${error.message}`;
    }
  }

  /** Read up to n points from the spill file; `commit()` removes them. */
  _peekSpill(id, n) {
    const file = this.spillPath(id);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    const nl = [];
    let idx = -1;
    while (nl.length < n) {
      idx = raw.indexOf('\n', idx + 1);
      if (idx === -1) break;
      nl.push(idx);
    }
    const cut = nl.length ? nl[nl.length - 1] + 1 : raw.length;
    const points = raw
      .slice(0, cut)
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (!points.length) {
      try {
        fs.unlinkSync(file);
      } catch {
        // already gone
      }
      return null;
    }
    return {
      points,
      commit: () => {
        const rest = raw.slice(cut);
        try {
          if (rest.length) fs.writeFileSync(file, rest, { mode: 0o600 });
          else fs.unlinkSync(file);
        } catch {
          // worst case the same points re-send — at-least-once, not at-most-once
        }
      }
    };
  }

  async flush() {
    if (this.flushing) return; // one flusher at a time; interval re-fires anyway
    this.flushing = true;
    try {
      const ids = new Set([...this.queues.keys(), ...this.stats.keys()]);
      // Also pick up spill files left over from a previous process.
      try {
        for (const f of fs.readdirSync(this.dir)) {
          if (f.endsWith('.jsonl')) ids.add(f.slice(0, -6));
        }
      } catch {
        // no outbox dir yet
      }
      for (const id of ids) await this._flushOne(id);
    } finally {
      this.flushing = false;
    }
  }

  async _flushOne(id) {
    const conn = this.profiles.getIn('historians', id);
    const s = this._stat(id);
    const q = this.queues.get(id) || [];
    if (!conn) {
      // Historian deleted: drop queue and spill, honestly counted.
      if (q.length) {
        s.dropped += q.length;
        q.length = 0;
      }
      try {
        fs.unlinkSync(this.spillPath(id));
      } catch {
        // nothing spilled
      }
      return;
    }

    // Oldest first: drain spill before the live queue so order roughly holds.
    for (;;) {
      const spill = this._peekSpill(id, BATCH);
      if (!spill) break;
      try {
        await historians.writePoints(conn, spill.points, this.fetchImpl);
        spill.commit();
        s.drained += spill.points.length;
        s.written += spill.points.length;
        s.lastWrite = Date.now();
        s.lastError = null;
      } catch (error) {
        s.lastError = error.message;
        break; // historian still down — stop, spill stays for next round
      }
    }

    while (q.length) {
      const batch = q.splice(0, BATCH);
      try {
        await historians.writePoints(conn, batch, this.fetchImpl);
        s.written += batch.length;
        s.lastWrite = Date.now();
        s.lastError = null;
      } catch (error) {
        s.lastError = error.message;
        this._spill(id, batch.concat(q.splice(0, q.length))); // everything to disk
      }
    }
  }

  getStats() {
    const out = {};
    for (const [id, s] of this.stats) {
      let spillBytes = 0;
      try {
        spillBytes = fs.statSync(this.spillPath(id)).size;
      } catch {
        // none
      }
      out[id] = { ...s, queued: this.queues.get(id)?.length || 0, spillBytes };
    }
    return out;
  }
}

module.exports = HistorianOutbox;
