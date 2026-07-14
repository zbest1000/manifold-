'use strict';

const SparkplugDecoder = require('./sparkplugDecoder');

/**
 * Live Sparkplug B topology registry — the "who is publishing what" map for
 * Sparkplug traffic, built purely from observed messages (no broker cooperation
 * needed).
 *
 * Sparkplug encodes real endpoint identity in the topic:
 *   spBv1.0/{group}/{msgType}/{edgeNode}[/{device}]
 * and BIRTH/DEATH certificates (NBIRTH/DBIRTH/NDEATH/DDEATH) announce edge nodes
 * and devices coming online/offline plus the metrics they publish. So by watching
 * the stream we can reconstruct the actual device tree — Group → Edge Node →
 * Device — with live online/offline state and each endpoint's metric set. These
 * are real publishing endpoints, not just topic strings.
 */
const MAX_EVENTS = 2000;

class SparkplugRegistry {
  constructor() {
    this.groups = new Map(); // groupId -> { id, edgeNodes: Map }
    this.lastUpdate = 0;
    this.events = []; // bounded ring of BIRTH/DEATH lifecycle events
  }

  _event(evt) {
    this.events.push(evt);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  _group(id) {
    let g = this.groups.get(id);
    if (!g) {
      g = { id, edgeNodes: new Map() };
      this.groups.set(id, g);
    }
    return g;
  }

  _edge(group, id) {
    let e = group.edgeNodes.get(id);
    if (!e) {
      e = { id, online: false, lastBirth: null, lastDeath: null, lastSeen: null, msgCount: 0, metrics: new Set(), devices: new Map() };
      group.edgeNodes.set(id, e);
    }
    return e;
  }

  _device(edge, id) {
    let d = edge.devices.get(id);
    if (!d) {
      d = { id, online: false, lastBirth: null, lastDeath: null, lastSeen: null, msgCount: 0, metrics: new Set() };
      edge.devices.set(id, d);
    }
    return d;
  }

  /**
   * Fold one Sparkplug message into the topology. `decoded` is the decoded
   * payload (may be null if decode failed — identity/state come from the topic).
   */
  update(topic, decoded, ts = Date.now()) {
    const info = SparkplugDecoder.parseSparkplugTopic(topic);
    if (!info) return;
    this.lastUpdate = ts;

    const group = this._group(info.groupId);
    const edge = this._edge(group, info.edgeNodeId);
    edge.lastSeen = ts;
    edge.msgCount++;

    const type = info.messageType;
    const target = info.deviceId ? this._device(edge, info.deviceId) : edge;
    if (info.deviceId) {
      target.lastSeen = ts;
      target.msgCount++;
    }

    if (type === 'NBIRTH' || type === 'DBIRTH') {
      target.online = true;
      target.lastBirth = ts;
      this._event({
        type: info.deviceId ? 'device-birth' : 'edge-birth',
        group: info.groupId,
        edgeNode: info.edgeNodeId,
        device: info.deviceId || null,
        ts
      });
    } else if (type === 'NDEATH' || type === 'DDEATH') {
      target.online = false;
      target.lastDeath = ts;
      this._event({
        type: info.deviceId ? 'device-death' : 'edge-death',
        group: info.groupId,
        edgeNode: info.edgeNodeId,
        device: info.deviceId || null,
        ts
      });
      // Sparkplug spec: an edge node's death implies ALL of its devices are
      // offline (their data path is gone). Cascade so the topology stays honest.
      if (type === 'NDEATH') {
        for (const d of edge.devices.values()) {
          if (d.online) {
            d.online = false;
            d.lastDeath = ts;
            this._event({ type: 'device-death', group: info.groupId, edgeNode: info.edgeNodeId, device: d.id, ts, cascaded: true });
          }
        }
      }
    }

    // Collect the metric names this endpoint publishes (BIRTH defines them; DATA
    // reaffirms them). This is the "publishes what" for the endpoint.
    if (decoded && Array.isArray(decoded.metrics)) {
      for (const m of decoded.metrics) {
        if (m && m.name) target.metrics.add(m.name);
      }
    }
  }

  /** Serializable snapshot of the whole topology. */
  toJSON() {
    const groups = [];
    let edgeCount = 0;
    let deviceCount = 0;
    let onlineCount = 0;
    for (const g of this.groups.values()) {
      const edgeNodes = [];
      for (const e of g.edgeNodes.values()) {
        edgeCount++;
        if (e.online) onlineCount++;
        const devices = [];
        for (const d of e.devices.values()) {
          deviceCount++;
          if (d.online) onlineCount++;
          devices.push({
            id: d.id,
            online: d.online,
            lastBirth: d.lastBirth,
            lastDeath: d.lastDeath,
            lastSeen: d.lastSeen,
            msgCount: d.msgCount,
            metrics: Array.from(d.metrics)
          });
        }
        edgeNodes.push({
          id: e.id,
          online: e.online,
          lastBirth: e.lastBirth,
          lastDeath: e.lastDeath,
          lastSeen: e.lastSeen,
          msgCount: e.msgCount,
          metrics: Array.from(e.metrics),
          devices
        });
      }
      groups.push({ id: g.id, edgeNodes });
    }
    return {
      groups,
      summary: {
        groups: groups.length,
        edgeNodes: edgeCount,
        devices: deviceCount,
        online: onlineCount,
        lastUpdate: this.lastUpdate
      }
    };
  }

  isEmpty() {
    return this.groups.size === 0;
  }
}

module.exports = SparkplugRegistry;
