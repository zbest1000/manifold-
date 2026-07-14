'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Message-history persistence: the per-broker "recent messages" rings survive a
 * server restart, so the detail views and payload diff don't come back empty.
 *
 * Deliberately NOT a database: the rings are already bounded (GLOBAL_RECENT per
 * broker), so a periodic JSON snapshot (atomic tmp+rename, 0600 like the
 * profile store) is the whole persistence story. Snapshots are taken on an
 * interval and at shutdown, and only written when messages actually arrived
 * since the last write. Restore only fills a broker's ring if it is still
 * empty — live traffic always wins over history.
 */

const SNAPSHOT_MS = 60_000;
const MAX_PER_BROKER = 1000; // snapshot cap per broker (ring itself may be larger)

class HistoryStore {
  constructor(mqttManager, dir = process.env.MANIFOLD_DATA_DIR || path.join(__dirname, '..', 'data')) {
    this.manager = mqttManager;
    this.dir = dir;
    this.file = path.join(dir, 'history.json');
    this.timer = null;
    this.lastSeq = -1; // manager.msgSeq watermark — skip writes when idle
    this.writing = false; // async write in flight
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.snapshot(), SNAPSHOT_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Snapshot the rings. The periodic path is ASYNC (serialization is cheap,
   * but a multi-MB write must not block the event loop mid-traffic); shutdown
   * passes { sync: true } because the process is about to exit.
   */
  snapshot({ sync = false } = {}) {
    if (this.manager.msgSeq === this.lastSeq) return false; // nothing new
    if (this.writing && !sync) return false; // previous async write still going
    this.lastSeq = this.manager.msgSeq;
    const out = {};
    for (const [brokerId, ring] of this.manager.recent) {
      if (ring.length) out[brokerId] = ring.slice(-MAX_PER_BROKER);
    }
    const body = JSON.stringify({ savedAt: new Date().toISOString(), brokers: out });
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      console.warn(`historyStore: snapshot failed: ${error.message}`);
      return false;
    }
    if (sync) {
      try {
        fs.writeFileSync(tmp, body, { mode: 0o600 });
        fs.renameSync(tmp, this.file);
        return true;
      } catch (error) {
        console.warn(`historyStore: snapshot failed: ${error.message}`);
        return false;
      }
    }
    this.writing = true;
    fs.promises
      .writeFile(tmp, body, { mode: 0o600 })
      .then(() => fs.promises.rename(tmp, this.file))
      .catch((error) => console.warn(`historyStore: snapshot failed: ${error.message}`))
      .finally(() => {
        this.writing = false;
      });
    return true;
  }

  /** Refill still-empty rings from the last snapshot (call after profile restore). */
  restore() {
    let loaded;
    try {
      loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return 0; // no snapshot yet, or unreadable — start clean
    }
    let restored = 0;
    for (const [brokerId, messages] of Object.entries(loaded.brokers || {})) {
      const ring = this.manager.recent.get(brokerId);
      if (ring && ring.length === 0 && Array.isArray(messages)) {
        ring.push(...messages.map((m) => ({ ...m, restored: true })));
        restored += messages.length;
      }
    }
    return restored;
  }
}

module.exports = HistoryStore;
