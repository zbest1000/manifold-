'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Audit log — who did what to the control plane, and when.
 *
 * Every mutating API call (anything but GET) is recorded with role, source IP,
 * route, outcome, and a redacted body summary, to an in-memory ring (for the
 * UI) and an append-only JSONL file in the data dir (for the record). This is
 * table stakes for industrial software: "who published to line1/cmd" must
 * have an answer.
 *
 * Secrets never land in the log: password/token/key fields are redacted by
 * name before serialization.
 */

const RING_MAX = 500;
const SECRET_KEYS = /pass|token|secret|key|credential/i;

function redact(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.length > 20 ? `[${value.length} items]` : value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) && v ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

class AuditLog {
  constructor(dir = process.env.MANIFOLD_DATA_DIR || path.join(__dirname, '..', 'data')) {
    this.file = path.join(dir, 'audit.jsonl');
    this.dir = dir;
    this.ring = [];
    this.stream = null;
  }

  record(entry) {
    const evt = { ts: new Date().toISOString(), ...entry };
    this.ring.push(evt);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    try {
      if (!this.stream) {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        this.stream = fs.createWriteStream(this.file, { flags: 'a', mode: 0o600 });
        this.stream.on('error', () => {
          this.stream = null; // re-open on next record
        });
      }
      this.stream.write(JSON.stringify(evt) + '\n');
    } catch {
      // the ring still has it; a broken disk must not break the API
    }
  }

  /** Express middleware: audit every mutating request after it completes. */
  middleware() {
    return (req, res, next) => {
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
      const started = Date.now();
      res.on('finish', () => {
        let summary;
        try {
          summary = req.body && Object.keys(req.body).length ? JSON.stringify(redact(req.body)).slice(0, 400) : undefined;
        } catch {
          summary = '[unserializable]';
        }
        this.record({
          role: req.role || 'open',
          ...(req.tokenName && req.tokenName !== 'open' ? { tokenName: req.tokenName } : {}),
          ip: req.ip,
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          ms: Date.now() - started,
          ...(summary ? { body: summary } : {})
        });
      });
      next();
    };
  }

  recent(limit = 200) {
    return this.ring.slice(-limit).reverse();
  }

  /** Flush and close the file stream; resolves once buffered lines hit disk. */
  close() {
    return new Promise((resolve) => {
      const stream = this.stream;
      this.stream = null;
      if (!stream) return resolve();
      stream.end(resolve);
    });
  }
}

module.exports = { AuditLog, redact };
