'use strict';

const { matchFilter } = require('./mqttMatch');

/**
 * Schema contracts — payload shape as a first-class, watchable promise.
 *
 * A contract locks the inferred JSON schema of a topic (or filter). Every
 * matching message on the coalesced tap is validated structurally; drift —
 * missing fields, new fields, changed types — is recorded in a bounded
 * violations ring and emitted on the socket. This catches the classic UNS
 * failure where a publisher "upgrades" its payload and silently breaks every
 * consumer downstream.
 *
 * Schemas are structural type descriptors, not JSON Schema documents:
 *   { type: 'object', props: { k: <schema> } } | { type: 'array', items }
 *   | { type: 'number'|'string'|'boolean'|'null' }
 * Arrays are described by their first element (industrial payload arrays are
 * homogeneous in practice; heterogeneous arrays diff as type changes).
 */

const VIOLATIONS_MAX = 500;

function inferSchema(value) {
  if (value === null || value === undefined) return { type: 'null' };
  if (Array.isArray(value)) {
    return { type: 'array', items: value.length ? inferSchema(value[0]) : { type: 'null' } };
  }
  const t = typeof value;
  if (t === 'object') {
    const props = {};
    for (const k of Object.keys(value).sort()) props[k] = inferSchema(value[k]);
    return { type: 'object', props };
  }
  if (t === 'number' || t === 'string' || t === 'boolean') return { type: t };
  return { type: 'string' };
}

/** Structural diff: expected schema vs actual value. Returns violations. */
function validate(schema, value, path = '', out = []) {
  const actual = inferSchema(value);
  if (schema.type === 'object' && actual.type === 'object') {
    for (const [k, sub] of Object.entries(schema.props || {})) {
      if (!(k in (value || {}))) out.push({ path: path ? `${path}.${k}` : k, kind: 'missing-field', expected: sub.type });
      else validate(sub, value[k], path ? `${path}.${k}` : k, out);
    }
    for (const k of Object.keys(value || {})) {
      if (!(k in (schema.props || {}))) out.push({ path: path ? `${path}.${k}` : k, kind: 'new-field', got: inferSchema(value[k]).type });
    }
    return out;
  }
  if (schema.type === 'array' && actual.type === 'array') {
    if (value.length) validate(schema.items || { type: 'null' }, value[0], `${path}[0]`, out);
    return out;
  }
  if (schema.type !== actual.type) {
    // null → anything is drift too, but a locked 'null' schema means "we never
    // saw a real payload"; don't punish the first real value's arrival type.
    if (schema.type !== 'null') out.push({ path: path || '(root)', kind: 'type-changed', expected: schema.type, got: actual.type });
  }
  return out;
}

class SchemaContracts {
  constructor({ mqttManager, profiles, io = null }) {
    this.manager = mqttManager;
    this.profiles = profiles;
    this.io = io;
    this.violations = []; // bounded ring, newest last
    this.counters = new Map(); // contractId -> { checked, violations, lastViolation }
    this.onMessage = this.onMessage.bind(this);
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.manager.on('message', this.onMessage);
  }

  stop() {
    this.manager.off('message', this.onMessage);
    this.started = false;
  }

  _counter(id) {
    let c = this.counters.get(id);
    if (!c) {
      c = { checked: 0, violations: 0, lastViolation: null };
      this.counters.set(id, c);
    }
    return c;
  }

  onMessage(msg) {
    for (const contract of this.profiles.listIn('contracts')) {
      if (contract.enabled === false) continue;
      if (contract.brokerId !== msg.brokerId) continue;
      if (!matchFilter(contract.filter, msg.topic)) continue;
      const c = this._counter(contract.id);
      c.checked++;
      const found = validate(contract.schema, msg.payload);
      if (!found.length) continue;
      c.violations++;
      c.lastViolation = Date.now();
      const evt = {
        contractId: contract.id,
        contractName: contract.name || contract.filter,
        brokerId: msg.brokerId,
        topic: msg.topic,
        ts: Date.now(),
        problems: found.slice(0, 20)
      };
      this.violations.push(evt);
      if (this.violations.length > VIOLATIONS_MAX) this.violations.splice(0, this.violations.length - VIOLATIONS_MAX);
      this.io?.emit('contract-violation', evt);
    }
  }

  /** Infer a contract schema from a topic's latest observed payload. */
  inferFromTopic(brokerId, topic) {
    const store = this.manager.stores.get(brokerId);
    if (!store) return null;
    const row = store.getLatest(topic);
    if (!row) return null;
    const msg = this.manager.buildMessage(brokerId, row);
    return inferSchema(msg.payload);
  }

  getViolations(limit = 200) {
    return this.violations.slice(-limit).reverse();
  }

  getCounters() {
    return Object.fromEntries(this.counters);
  }
}

module.exports = { SchemaContracts, inferSchema, validate };
