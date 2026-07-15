'use strict';

const fs = require('fs');
const path = require('path');

// DataOps collections stored alongside connection profiles. Generic CRUD keeps
// the store from growing three near-identical method triples per module.
const COLLECTIONS = ['historians', 'pipelines', 'models', 'recordings', 'contracts', 'bindings', 'icons'];
function emptyCollections() {
  return Object.fromEntries(COLLECTIONS.map((c) => [c, {}]));
}

/**
 * Connection-profile persistence: saved brokers, OPC UA endpoints, CESMII / i3X
 * configs, and per-broker admin API configs survive a server restart.
 *
 * Storage is a single JSON file (default `<server>/data/profiles.json`,
 * override with MANIFOLD_DATA_DIR), written atomically (tmp + rename) with mode 0600.
 * It CAN contain credentials (broker passwords, admin API secrets) — that is the
 * point of persistence — so the file is owner-readable only and the README says
 * so plainly. Encrypting at rest without a real key-management story would be
 * security theater; restrict the file and the host instead.
 *
 * Shape:
 *   { mqtt: { [id]: { config, admin? } }, opcua: { [id]: config },
 *     cesmii: config|null, i3x: config|null,
 *     mounts: { [id]: mount }, alertRules: { [id]: rule } }
 */
class ProfileStore {
  constructor(dir = process.env.MANIFOLD_DATA_DIR || path.join(__dirname, '..', 'data')) {
    this.dir = dir;
    this.file = path.join(dir, 'profiles.json');
    this.data = { mqtt: {}, opcua: {}, cesmii: null, i3x: null, mounts: {}, alertRules: {}, ...emptyCollections() };
    // Monotonic revision, bumped on every save. Hot-path consumers (pipeline/
    // recorder/contract/model engines) compile the collections into matcher
    // tables and only rebuild when this changes — so the per-message cost is a
    // number comparison, not Object.values() + filter parsing per engine.
    this.rev = 1;
    this._load();
  }

  _load() {
    let raw = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return; // no file yet — start clean
    }
    try {
      const parsed = JSON.parse(raw);
      this.data = {
        mqtt: parsed.mqtt || {},
        opcua: parsed.opcua || {},
        cesmii: parsed.cesmii || null,
        i3x: parsed.i3x || null,
        mounts: parsed.mounts || {},
        alertRules: parsed.alertRules || {},
        ...Object.fromEntries(COLLECTIONS.map((c) => [c, parsed[c] || {}]))
      };
    } catch {
      // Corrupt JSON: keep the evidence instead of silently discarding every
      // saved connection — the .bak lets an operator recover credentials.
      try {
        fs.writeFileSync(`${this.file}.bak`, raw, { mode: 0o600 });
        console.error(`profileStore: ${this.file} is corrupt — backed up to ${this.file}.bak and starting clean`);
      } catch {
        // best effort
      }
    }
  }

  _save() {
    this.rev++;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, ...this.data }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error('profileStore: failed to persist profiles:', error.message);
    }
  }

  // ---- MQTT brokers ----
  upsertBroker(id, config) {
    this.data.mqtt[id] = { ...(this.data.mqtt[id] || {}), config: { ...config, id } };
    this._save();
  }

  removeBroker(id) {
    if (this.data.mqtt[id]) {
      delete this.data.mqtt[id];
      this._save();
    }
  }

  setBrokerAdmin(id, adminConfig) {
    if (!this.data.mqtt[id]) this.data.mqtt[id] = { config: { id } };
    this.data.mqtt[id].admin = adminConfig;
    this._save();
  }

  clearBrokerAdmin(id) {
    if (this.data.mqtt[id]?.admin) {
      delete this.data.mqtt[id].admin;
      this._save();
    }
  }

  brokers() {
    return Object.values(this.data.mqtt);
  }

  // ---- OPC UA ----
  upsertOpcua(id, config) {
    this.data.opcua[id] = { ...config, id };
    this._save();
  }

  removeOpcua(id) {
    if (this.data.opcua[id]) {
      delete this.data.opcua[id];
      this._save();
    }
  }

  opcuaEndpoints() {
    return Object.values(this.data.opcua);
  }

  // ---- singleton configs ----
  setCesmii(config) {
    this.data.cesmii = config;
    this._save();
  }

  clearCesmii() {
    this.data.cesmii = null;
    this._save();
  }

  setI3x(config) {
    this.data.i3x = config;
    this._save();
  }

  clearI3x() {
    this.data.i3x = null;
    this._save();
  }

  // ---- UNS mounts (external sources grafted into the namespace view) ----
  upsertMount(id, mount) {
    this.data.mounts[id] = { ...mount, id };
    this._save();
    return this.data.mounts[id];
  }

  removeMount(id) {
    if (this.data.mounts[id]) {
      delete this.data.mounts[id];
      this._save();
      return true;
    }
    return false;
  }

  mounts() {
    return Object.values(this.data.mounts);
  }

  // ---- alert rules ----
  upsertAlertRule(id, rule) {
    this.data.alertRules[id] = { ...rule, id };
    this._save();
    return this.data.alertRules[id];
  }

  removeAlertRule(id) {
    if (this.data.alertRules[id]) {
      delete this.data.alertRules[id];
      this._save();
      return true;
    }
    return false;
  }

  alertRules() {
    return Object.values(this.data.alertRules);
  }

  // ---- generic DataOps collections (historians, pipelines, models, ...) ----
  upsertIn(collection, id, obj) {
    if (!COLLECTIONS.includes(collection)) throw new Error(`unknown collection ${collection}`);
    this.data[collection][id] = { ...obj, id };
    this._save();
    return this.data[collection][id];
  }

  removeIn(collection, id) {
    if (!COLLECTIONS.includes(collection)) throw new Error(`unknown collection ${collection}`);
    if (this.data[collection][id]) {
      delete this.data[collection][id];
      this._save();
      return true;
    }
    return false;
  }

  listIn(collection) {
    if (!COLLECTIONS.includes(collection)) throw new Error(`unknown collection ${collection}`);
    return Object.values(this.data[collection]);
  }

  getIn(collection, id) {
    if (!COLLECTIONS.includes(collection)) throw new Error(`unknown collection ${collection}`);
    return this.data[collection][id] || null;
  }
}

module.exports = ProfileStore;
