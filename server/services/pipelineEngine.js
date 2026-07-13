'use strict';

const { matchFilter } = require('./mqttMatch');
const historians = require('./historians');

/**
 * Pipeline engine — Manifold's DataOps core: source → transforms → target
 * routes over the live message stream.
 *
 * Routes are persisted in the profile store and evaluated against the
 * manager's coalesced message tap (bounded by topics touched per flush, never
 * raw publish rate). Transforms are a small, ordered vocabulary — enough to
 * re-path a messy namespace into a clean UNS, reshape payloads, convert units,
 * and flatten Sparkplug — deliberately not a general scripting runtime.
 *
 * Route shape:
 *   { id, name, enabled,
 *     source: { brokerId, filter },
 *     transforms: [ { type: 'repath'|'pick'|'rename'|'set'|'scale'|'numeric'|'sparkplugFlatten', ... } ],
 *     target: { type: 'mqtt', brokerId, retain?, qos? }
 *           | { type: 'historian', historianId } }
 *
 * Safety: a route whose output topic matches its own source filter would feed
 * itself forever (publish → ingest → match → publish). The engine drops such
 * messages and counts them as loopBlocked instead of publishing.
 */

const HISTORIAN_FLUSH_MS = 2000;
const HISTORIAN_BUFFER_MAX = 5000;

// ---- transforms ---------------------------------------------------------------

/**
 * Apply `{n}` segment templates: `{1}`..`{n}` = 1-based source segment,
 * `{n-}` = segments n..end joined, `{topic}` = whole source topic.
 */
function applyTemplate(template, topic) {
  const segs = topic.split('/');
  return String(template)
    .replace(/\{topic\}/g, topic)
    .replace(/\{(\d+)-\}/g, (_, n) => segs.slice(Number(n) - 1).join('/'))
    .replace(/\{(\d+)\}/g, (_, n) => segs[Number(n) - 1] ?? '');
}

/**
 * Run the transform chain over one message. Returns { topic, payload } or
 * null when a step filtered the message out. Never throws on payload shape —
 * a transform that doesn't apply passes the message through unchanged.
 */
function applyTransforms(transforms, msg) {
  let topic = msg.topic;
  let payload = msg.payload;

  for (const t of transforms || []) {
    switch (t.type) {
      case 'repath':
        topic = applyTemplate(t.to || '{topic}', msg.topic);
        break;
      case 'pick':
        if (payload && typeof payload === 'object' && Array.isArray(t.fields)) {
          const next = {};
          for (const f of t.fields) if (f in payload) next[f] = payload[f];
          payload = next;
        }
        break;
      case 'rename':
        if (payload && typeof payload === 'object' && t.map && typeof t.map === 'object') {
          const next = {};
          for (const [k, v] of Object.entries(payload)) next[t.map[k] || k] = v;
          payload = next;
        }
        break;
      case 'set':
        if (t.values && typeof t.values === 'object') {
          payload = payload && typeof payload === 'object' ? { ...payload, ...t.values } : { value: payload, ...t.values };
        }
        break;
      case 'scale': {
        const mul = Number.isFinite(Number(t.mul)) ? Number(t.mul) : 1;
        const add = Number.isFinite(Number(t.add)) ? Number(t.add) : 0;
        if (t.field && payload && typeof payload === 'object') {
          const v = Number(payload[t.field]);
          if (Number.isFinite(v)) payload = { ...payload, [t.field]: v * mul + add };
        } else {
          const v = Number(payload);
          if (Number.isFinite(v)) payload = v * mul + add;
        }
        break;
      }
      case 'numeric': {
        const v = t.field && payload && typeof payload === 'object' ? Number(payload[t.field]) : Number(payload);
        if (!Number.isFinite(v)) return null; // not numeric → drop (filter semantics)
        payload = v;
        break;
      }
      case 'sparkplugFlatten':
        if (msg.sparkplug && Array.isArray(msg.sparkplug.metrics)) {
          const next = {};
          for (const m of msg.sparkplug.metrics) {
            if (m && m.name !== undefined) next[m.name] = m.value;
          }
          payload = next;
        }
        break;
      default:
        break; // unknown step: pass through (forward compatibility)
    }
  }
  return { topic, payload };
}

class PipelineEngine {
  constructor({ mqttManager, profiles, fetchImpl = globalThis.fetch }) {
    this.manager = mqttManager;
    this.profiles = profiles;
    this.fetchImpl = fetchImpl;
    this.metrics = new Map(); // routeId -> { matched, published, errors, loopBlocked, lastError, lastTs }
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

  _metric(routeId) {
    let m = this.metrics.get(routeId);
    if (!m) {
      m = { matched: 0, published: 0, errors: 0, loopBlocked: 0, lastError: null, lastTs: 0 };
      this.metrics.set(routeId, m);
    }
    return m;
  }

  onMessage(msg) {
    for (const route of this.profiles.listIn('pipelines')) {
      if (route.enabled === false) continue;
      if (!route.source || route.source.brokerId !== msg.brokerId) continue;
      if (!matchFilter(route.source.filter, msg.topic)) continue;
      const m = this._metric(route.id);
      m.matched++;
      m.lastTs = Date.now();
      try {
        const out = applyTransforms(route.transforms, msg);
        if (!out) continue; // filtered by a transform (e.g. non-numeric dropped)
        this._deliver(route, m, out, msg);
      } catch (error) {
        m.errors++;
        m.lastError = error.message;
      }
    }
  }

  _deliver(route, m, out, msg) {
    const target = route.target || {};
    if (target.type === 'mqtt') {
      // Loop guard: output re-entering this route's own source is a feedback loop.
      if (target.brokerId === route.source.brokerId && matchFilter(route.source.filter, out.topic)) {
        m.loopBlocked++;
        m.lastError = `loop blocked: output topic "${out.topic}" matches the route's own source filter`;
        return;
      }
      this.manager
        .publish(target.brokerId, out.topic, out.payload, { qos: target.qos || 0, retain: Boolean(target.retain) })
        .then(() => {
          m.published++;
        })
        .catch((error) => {
          m.errors++;
          m.lastError = error.message;
        });
    } else if (target.type === 'historian') {
      let buf = this.buffers.get(target.historianId);
      if (!buf) {
        buf = [];
        this.buffers.set(target.historianId, buf);
      }
      if (buf.length >= HISTORIAN_BUFFER_MAX) {
        m.errors++;
        m.lastError = 'historian buffer full (writes failing or too slow)';
        return;
      }
      buf.push({ tag: out.topic, ts: new Date(msg.timestamp).getTime() || Date.now(), value: out.payload, routeId: route.id });
      m.published++; // counted at buffer admission; write failures surface via lastError below
    }
  }

  async flushHistorians() {
    for (const [historianId, buf] of this.buffers) {
      if (!buf.length) continue;
      const conn = this.profiles.getIn('historians', historianId);
      const points = buf.splice(0, buf.length);
      if (!conn) continue; // historian deleted; drop silently
      try {
        await historians.writePoints(conn, points, this.fetchImpl);
      } catch (error) {
        for (const routeId of new Set(points.map((p) => p.routeId))) {
          const m = this._metric(routeId);
          m.errors++;
          m.lastError = error.message;
        }
      }
    }
  }

  /**
   * Dry-run a route against the observed topic set: resolve the source filter
   * via the trie, pull each sample's latest payload, run the transform chain,
   * and report the in→out mapping WITHOUT publishing anything.
   */
  preview(route, { sampleLimit = 25 } = {}) {
    const store = this.manager.stores.get(route.source?.brokerId);
    if (!store) return { error: 'source broker not connected', matchCount: 0, rows: [] };
    const resolved = this.manager.resolveSubscriptions(route.source.brokerId, [route.source.filter], { sampleLimit });
    const result = resolved?.results?.[0];
    if (!result) return { error: 'filter did not resolve', matchCount: 0, rows: [] };

    const rows = [];
    for (const s of result.sample) {
      const row = store.getLatest(s.topic);
      if (!row) continue;
      const msg = this.manager.buildMessage(route.source.brokerId, row);
      const out = applyTransforms(route.transforms, msg);
      rows.push({
        inTopic: s.topic,
        inPayload: msg.payload,
        outTopic: out ? out.topic : null,
        outPayload: out ? out.payload : null,
        dropped: !out,
        loop:
          Boolean(out) &&
          route.target?.type === 'mqtt' &&
          route.target.brokerId === route.source.brokerId &&
          matchFilter(route.source.filter, out.topic)
      });
    }
    return { matchCount: result.matchCount, sampleTruncated: result.sampleTruncated, rows };
  }

  getMetrics() {
    return Object.fromEntries(this.metrics);
  }
}

module.exports = { PipelineEngine, applyTransforms, applyTemplate };
