'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Connection-profile persistence: saved brokers, OPC UA endpoints, CESMII / i3X
 * configs, and per-broker admin API configs survive a server restart.
 *
 * Storage is a single JSON file (default `<server>/data/profiles.json`,
 * override with TC_DATA_DIR), written atomically (tmp + rename) with mode 0600.
 * It CAN contain credentials (broker passwords, admin API secrets) — that is the
 * point of persistence — so the file is owner-readable only and the README says
 * so plainly. Encrypting at rest without a real key-management story would be
 * security theater; restrict the file and the host instead.
 *
 * Shape:
 *   { mqtt: { [id]: { config, admin? } }, opcua: { [id]: config },
 *     cesmii: config|null, i3x: config|null }
 */
class ProfileStore {
  constructor(dir = process.env.TC_DATA_DIR || path.join(__dirname, '..', 'data')) {
    this.dir = dir;
    this.file = path.join(dir, 'profiles.json');
    this.data = { mqtt: {}, opcua: {}, cesmii: null, i3x: null };
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        mqtt: parsed.mqtt || {},
        opcua: parsed.opcua || {},
        cesmii: parsed.cesmii || null,
        i3x: parsed.i3x || null
      };
    } catch {
      // no file yet, or unreadable/corrupt — start clean, don't crash the server
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
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
}

module.exports = ProfileStore;
