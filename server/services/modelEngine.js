'use strict';

const { compiledView } = require('./mqttMatch');

/**
 * Model engine — the contextualization layer (the HighByte-shaped idea):
 * define an instance model whose attributes are bound to different live
 * sources, and publish the merged object at one clean UNS path. Ten raw
 * topics from three subsystems become one `Pump-7` object.
 *
 * Model shape (profile store `models`):
 *   { id, name, enabled,
 *     target: { brokerId, topic, retain? },
 *     publishMode: 'on-change' | 'interval', intervalMs?,
 *     attributes: [ { name, source: { brokerId, topic, field? } } ] }
 *
 * `field` plucks one key out of an object payload; omitted = whole payload.
 * on-change publishes are debounced (min 200 ms) so a burst updating five
 * attributes produces one object, not five.
 */

const DEBOUNCE_MS = 200;

class ModelEngine {
  constructor({ mqttManager, profiles }) {
    this.manager = mqttManager;
    this.profiles = profiles;
    this.state = new Map(); // modelId -> { values: Map(attr -> {value, ts}), publishes, errors, lastError, lastPublish, debounce, timer }
    this.onMessage = this.onMessage.bind(this);
    this.started = false;
    // Compiled source index: exact (broker, topic) -> [{ model, attr }].
    // Model sources are exact topics, so dispatch is one Map lookup per message
    // instead of a models × attributes scan.
    this.index = compiledView(profiles, () => {
      const idx = new Map();
      for (const model of this.profiles.listIn('models')) {
        if (model.enabled === false) continue;
        for (const attr of model.attributes || []) {
          const src = attr.source || {};
          if (!src.brokerId || !src.topic) continue;
          const key = `${src.brokerId} ${src.topic}`;
          if (!idx.has(key)) idx.set(key, []);
          idx.get(key).push({ model, attr });
        }
      }
      return idx;
    });
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.manager.on('message', this.onMessage);
    this.syncTimers();
  }

  stop() {
    this.manager.off('message', this.onMessage);
    for (const s of this.state.values()) {
      clearTimeout(s.debounce);
      clearInterval(s.timer);
    }
    this.started = false;
  }

  _state(id) {
    let s = this.state.get(id);
    if (!s) {
      s = { values: new Map(), publishes: 0, errors: 0, lastError: null, lastPublish: 0, debounce: null, timer: null };
      this.state.set(id, s);
    }
    return s;
  }

  /** Reconcile interval timers with the current model list (call after CRUD). */
  syncTimers() {
    const models = this.profiles.listIn('models');
    const live = new Set(models.map((m) => m.id));
    for (const [id, s] of this.state) {
      if (!live.has(id)) {
        clearTimeout(s.debounce);
        clearInterval(s.timer);
        this.state.delete(id);
      }
    }
    for (const model of models) {
      const s = this._state(model.id);
      clearInterval(s.timer);
      s.timer = null;
      if (this.started && model.enabled !== false && model.publishMode === 'interval') {
        const ms = Math.max(500, Number(model.intervalMs) || 5000);
        s.timer = setInterval(() => this.publish(model), ms);
        s.timer.unref?.();
      }
    }
  }

  onMessage(msg) {
    const hits = this.index().get(`${msg.brokerId} ${msg.topic}`);
    if (!hits) return;
    const touched = new Set();
    for (const { model, attr } of hits) {
      const src = attr.source;
      const value = src.field && msg.payload && typeof msg.payload === 'object' ? msg.payload[src.field] : msg.payload;
      this._state(model.id).values.set(attr.name, { value, ts: Date.now() });
      if (model.publishMode !== 'interval') touched.add(model);
    }
    for (const model of touched) {
      const s = this._state(model.id);
      clearTimeout(s.debounce);
      s.debounce = setTimeout(() => this.publish(model), DEBOUNCE_MS);
      s.debounce.unref?.();
    }
  }

  publish(model) {
    const s = this._state(model.id);
    if (!s.values.size) return; // nothing bound yet
    const target = model.target || {};
    // Loop guard: a model must not source from its own output topic.
    if ((model.attributes || []).some((a) => a.source?.brokerId === target.brokerId && a.source?.topic === target.topic)) {
      s.lastError = 'loop blocked: an attribute sources the model output topic';
      return;
    }
    const now = Date.now();
    const staleMs = Number(model.staleMs) > 0 ? Number(model.staleMs) : 60_000;
    const payload = { _ts: new Date(now).toISOString() };
    for (const attr of model.attributes || []) {
      const v = s.values.get(attr.name);
      if (model.envelope) {
        // TVQ per attribute: a consumer can tell "never seen" (q=0) from
        // "stale" (q=64, OPC uncertain) from "fresh" — instead of a bare null.
        payload[attr.name] = v
          ? { v: v.value, t: v.ts, q: now - v.ts > staleMs ? 64 : 192 }
          : { v: null, t: null, q: 0 };
      } else {
        payload[attr.name] = v ? v.value : null;
      }
    }
    this.manager
      .publish(target.brokerId, target.topic, payload, { retain: Boolean(target.retain) })
      .then(() => {
        s.publishes++;
        s.lastPublish = Date.now();
      })
      .catch((error) => {
        s.errors++;
        s.lastError = error.message;
      });
  }

  getStatus() {
    const out = {};
    for (const [id, s] of this.state) {
      out[id] = {
        boundAttributes: s.values.size,
        publishes: s.publishes,
        errors: s.errors,
        lastError: s.lastError,
        lastPublish: s.lastPublish
      };
    }
    return out;
  }
}

module.exports = ModelEngine;
