'use strict';

/**
 * Memory-lean topic store (pure JS, no native dependency).
 *
 * At millions of resident topics, a Map of `{count, qos, retain, ts, payload}`
 * record objects plus a Buffer per topic costs hundreds of MB in per-object /
 * per-Buffer overhead and creates GC pressure. This store instead keeps a
 * struct-of-arrays: one `Map(topic -> slot)` plus parallel typed arrays for the
 * scalar fields, and the latest payload as a **latin1 string** — which V8 stores
 * at one byte per char, is lossless for arbitrary bytes, and avoids Buffer object
 * overhead entirely. Bytes are recovered lazily at flush (`Buffer.from(str,
 * 'latin1')`) only for the coalesced dirty topics.
 *
 * Same coalescing semantics as before: `ingest` is O(1); `drain` returns the
 * latest value per topic touched since the last drain.
 */
// Per-topic payload cap. Manifold auto-subscribes '#' to brokers whose other
// clients are untrusted, so a single publisher sending huge payloads across many
// topics could otherwise grow the store (topics x payload bytes) without bound
// and OOM the process. Payloads above the cap are truncated for storage/preview;
// the full message is never retained. 256 KB is already far larger than normal
// telemetry; override with MANIFOLD_MAX_PAYLOAD_BYTES.
const DEFAULT_MAX_PAYLOAD_BYTES = Number(process.env.MANIFOLD_MAX_PAYLOAD_BYTES) || 256 * 1024;

class TopicStore {
  constructor(maxTopics = 2_000_000, maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES) {
    this.index = new Map(); // topic -> slot
    this.cap = 1024;
    this.n = 0;
    this.count = new Uint32Array(this.cap);
    this.ts = new Float64Array(this.cap);
    this.flags = new Uint8Array(this.cap); // bit0 retain, bits1-2 qos, bit3 truncated
    this.payload = new Array(this.cap); // latest payload as a latin1 string (capped)
    this.fullSize = new Uint32Array(this.cap); // slot -> true byte size before truncation
    this.topics = new Array(this.cap); // slot -> topic (reverse of index; enables incremental consumers)
    this.firstSeen = new Float64Array(this.cap); // slot -> first-observation ts
    this.events = []; // bounded ring of namespace events (new topics only — rare in steady state)
    this.eventSeq = 0; // monotonic event id — lets consumers watermark exactly (ms timestamps collide)
    this.dirty = new Set();
    this.maxTopics = maxTopics;
    this.maxPayloadBytes = maxPayloadBytes;
    this.total = 0;
    this.dropped = 0;
    this.truncatedCount = 0;
  }

  _grow() {
    const nc = this.cap * 2;
    const count = new Uint32Array(nc);
    count.set(this.count);
    this.count = count;
    const ts = new Float64Array(nc);
    ts.set(this.ts);
    this.ts = ts;
    const flags = new Uint8Array(nc);
    flags.set(this.flags);
    this.flags = flags;
    this.payload.length = nc;
    this.topics.length = nc;
    const fullSize = new Uint32Array(nc);
    fullSize.set(this.fullSize);
    this.fullSize = fullSize;
    const fs = new Float64Array(nc);
    fs.set(this.firstSeen);
    this.firstSeen = fs;
    this.cap = nc;
  }

  /** Hot path: record the latest payload for a topic and mark it dirty. */
  ingest(topic, message, qos, retain) {
    this.total++;
    let slot = this.index.get(topic);
    if (slot === undefined) {
      if (this.index.size >= this.maxTopics) {
        this.dropped++;
        return false;
      }
      if (this.n >= this.cap) this._grow();
      slot = this.n++;
      this.index.set(topic, slot);
      this.topics[slot] = topic; // string ref only; the string already lives as the Map key
      this.count[slot] = 0;
      this.firstSeen[slot] = Date.now();
      // Namespace event: a topic appearing is rare after warm-up and worth a ring
      // entry (drives the UNS "namespace events" feed). Bounded hard. $-topics
      // ($SYS etc.) are broker plumbing, not namespace changes.
      if (topic.charCodeAt(0) !== 36 /* '$' */) {
        this.events.push({ type: 'topic-added', topic, ts: this.firstSeen[slot], seq: ++this.eventSeq });
        if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
      }
    }
    this.count[slot]++;
    this.ts[slot] = Date.now();
    // Cap the retained bytes: truncate above maxPayloadBytes and flag it (bit3),
    // so store, drain, the recent ring, and JSON.parse all inherit the bound.
    let stored = message;
    let truncated = 0;
    if (message.length > this.maxPayloadBytes) {
      stored = message.subarray(0, this.maxPayloadBytes);
      truncated = 8; // bit3
      this.truncatedCount++;
    }
    this.fullSize[slot] = message.length;
    this.flags[slot] = (retain ? 1 : 0) | ((qos & 3) << 1) | truncated;
    // latin1 = 1 byte/char in V8, lossless for any byte sequence.
    this.payload[slot] = stored.toString('latin1');
    this.dirty.add(topic);
    return true;
  }

  _rowAt(topic, slot) {
    const f = this.flags[slot];
    return {
      topic,
      slot,
      buffer: Buffer.from(this.payload[slot], 'latin1'),
      qos: (f >> 1) & 3,
      retain: (f & 1) === 1,
      truncated: (f & 8) === 8,
      fullSize: this.fullSize[slot],
      ts: this.ts[slot],
      count: this.count[slot]
    };
  }

  /** Coalesced drain of everything touched since the last drain. */
  drain() {
    const out = [];
    for (const topic of this.dirty) {
      const slot = this.index.get(topic);
      if (slot !== undefined && this.payload[slot] !== undefined) out.push(this._rowAt(topic, slot));
    }
    this.dirty.clear();
    return out;
  }

  /** Bounded snapshot of latest values for the REST endpoint. */
  getTopics(limit = Infinity) {
    const out = [];
    for (const [topic, slot] of this.index) {
      if (out.length >= limit) break;
      out.push(this._rowAt(topic, slot));
    }
    return out;
  }

  getLatest(topic) {
    const slot = this.index.get(topic);
    return slot === undefined ? null : this._rowAt(topic, slot);
  }

  /** All topics starting with `prefix` (used for the small `$SYS/` tree). */
  getByPrefix(prefix, limit = 2000) {
    const out = [];
    for (const [topic, slot] of this.index) {
      if (out.length >= limit) break;
      if (topic.startsWith(prefix)) out.push(this._rowAt(topic, slot));
    }
    return out;
  }

  /** Topic string for a slot (slots are monotonic and never freed). */
  topicAt(slot) {
    return this.topics[slot];
  }

  topicCount() {
    return this.index.size;
  }
}

module.exports = TopicStore;
