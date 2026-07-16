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
// Bounds against untrusted broker traffic: a hostile/misbehaving publisher can
// otherwise drive per-endpoint metric sets or the endpoint tree to grow without
// limit (payload-driven, so the topic cap doesn't bound it) and OOM the process.
const MAX_METRICS_PER_ENDPOINT = 5000;
const MAX_ENDPOINTS = 50_000; // edges + devices across all groups

class SparkplugRegistry {
  constructor() {
    this.groups = new Map(); // groupId -> { id, edgeNodes: Map }
    this.hosts = new Map(); // hostId -> { id, online, timestamp, lastSeen, msgCount }
    this.lastUpdate = 0;
    this.events = []; // bounded ring of BIRTH/DEATH lifecycle events
    this.endpointCount = 0; // edges + devices (bounded by MAX_ENDPOINTS)
    this.droppedEndpoints = 0; // endpoints refused past the cap
    this.metricOverflows = 0; // endpoints that hit MAX_METRICS_PER_ENDPOINT
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
      if (this.endpointCount >= MAX_ENDPOINTS) {
        this.droppedEndpoints++;
        return null;
      }
      e = { id, online: false, lastBirth: null, lastDeath: null, lastSeen: null, msgCount: 0, metrics: new Set(), aliasMap: new Map(), devices: new Map() };
      group.edgeNodes.set(id, e);
      this.endpointCount++;
    }
    return e;
  }

  _device(edge, id) {
    let d = edge.devices.get(id);
    if (!d) {
      if (this.endpointCount >= MAX_ENDPOINTS) {
        this.droppedEndpoints++;
        return null;
      }
      d = { id, online: false, lastBirth: null, lastDeath: null, lastSeen: null, msgCount: 0, metrics: new Set(), aliasMap: new Map() };
      edge.devices.set(id, d);
      this.endpointCount++;
    }
    return d;
  }

  // Add a metric name to an endpoint's set, bounded so a stream of unique names
  // from one topic's payloads can't grow it without limit.
  _addMetric(target, name) {
    if (target.metrics.has(name)) return;
    if (target.metrics.size >= MAX_METRICS_PER_ENDPOINT) {
      if (!target.metricsOverflow) {
        target.metricsOverflow = true;
        this.metricOverflows++;
      }
      return;
    }
    target.metrics.add(name);
  }

  _host(id) {
    let h = this.hosts.get(id);
    if (!h) {
      // online starts null (unknown) so the very first STATE message counts as
      // a transition and emits exactly one lifecycle event.
      h = { id, online: null, timestamp: null, lastSeen: null, msgCount: 0 };
      this.hosts.set(id, h);
    }
    return h;
  }

  /**
   * Fold a spBv1.0/STATE/{host} message. Sparkplug 3.0 STATE is JSON
   * `{ online, timestamp }`; legacy 2.x is plain text 'ONLINE'/'OFFLINE'.
   * Unknown shapes mark the host as seen but leave its online state alone.
   * STATE is retained (every new subscriber replays it), so lifecycle events
   * are pushed only on actual transitions.
   */
  _hostState(hostId, payload, ts) {
    const host = this._host(hostId);
    host.lastSeen = ts;
    host.msgCount++;

    let online = null;
    let timestamp = null;
    const raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
    if (raw && typeof raw === 'object' && typeof raw.online === 'boolean') {
      online = raw.online;
      if (Number.isFinite(Number(raw.timestamp))) timestamp = Number(raw.timestamp);
    } else if (typeof raw === 'string') {
      const text = raw.trim().toUpperCase();
      if (text === 'ONLINE') online = true;
      else if (text === 'OFFLINE') online = false;
    }
    if (online === null) return; // unrecognized payload — seen, state unchanged

    if (timestamp !== null) host.timestamp = timestamp;
    if (host.online !== online) {
      host.online = online;
      this._event({ type: online ? 'host-online' : 'host-offline', host: hostId, ts });
    }
  }

  /**
   * Fold one Sparkplug message into the topology. `decoded` is the decoded
   * payload (may be null if decode failed — identity/state come from the topic).
   * `payload` is the raw (JSON-parsed or string) payload, used for STATE
   * messages, which are not protobuf.
   */
  update(topic, decoded, ts = Date.now(), payload = null) {
    const info = SparkplugDecoder.parseSparkplugTopic(topic);
    if (!info) return;
    this.lastUpdate = ts;

    if (info.messageType === 'STATE') {
      this._hostState(info.hostId, payload, ts);
      return;
    }

    const group = this._group(info.groupId);
    const edge = this._edge(group, info.edgeNodeId);
    if (!edge) return; // endpoint cap reached — drop-and-count (see _edge)
    edge.lastSeen = ts;
    edge.msgCount++;

    const type = info.messageType;
    const target = info.deviceId ? this._device(edge, info.deviceId) : edge;
    if (!target) return; // device endpoint cap reached
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

    // Learn alias -> name from BIRTH certificates, which carry both. This is the
    // standard Sparkplug bandwidth optimization: NBIRTH/DBIRTH send {name, alias}
    // once, then NDATA/DDATA send {alias} only. Without this map every
    // alias-only DATA metric decodes with an empty name and is lost.
    if ((type === 'NBIRTH' || type === 'DBIRTH') && decoded && Array.isArray(decoded.metrics)) {
      for (const m of decoded.metrics) {
        if (m && m.name && m.alias !== undefined && m.alias !== null && target.aliasMap.size < MAX_METRICS_PER_ENDPOINT) {
          target.aliasMap.set(String(m.alias), m.name);
        }
      }
    }

    // Collect the metric names this endpoint publishes (BIRTH defines them; DATA
    // reaffirms them), resolving alias-only DATA metrics through the learned map.
    if (decoded && Array.isArray(decoded.metrics)) {
      for (const m of decoded.metrics) {
        if (!m) continue;
        let name = m.name;
        if (!name && m.alias !== undefined && m.alias !== null) {
          name = target.aliasMap.get(String(m.alias));
        }
        if (name) this._addMetric(target, name);
      }
    }
  }

  /**
   * Stamp resolved names onto a decoded metrics array in place, using the
   * endpoint's learned alias map. Called by the manager on messageObj.sparkplug
   * before the DataOps tap emit, so pipelines / sparkplugFlatten see real metric
   * names instead of collapsing every alias-only metric into the empty-name key.
   */
  resolveMetricNames(topic, metrics) {
    if (!Array.isArray(metrics) || !metrics.length) return metrics;
    const info = SparkplugDecoder.parseSparkplugTopic(topic);
    if (!info || info.messageType === 'STATE') return metrics;
    const edge = this.groups.get(info.groupId)?.edgeNodes.get(info.edgeNodeId);
    if (!edge) return metrics;
    const target = info.deviceId ? edge.devices.get(info.deviceId) : edge;
    if (!target || !target.aliasMap.size) return metrics;
    for (const m of metrics) {
      if (m && !m.name && m.alias !== undefined && m.alias !== null) {
        const name = target.aliasMap.get(String(m.alias));
        if (name) {
          m.name = name;
          m.nameResolved = true;
        }
      }
    }
    return metrics;
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
    const hosts = [];
    for (const h of this.hosts.values()) {
      hosts.push({
        id: h.id,
        online: h.online,
        timestamp: h.timestamp,
        lastSeen: h.lastSeen,
        msgCount: h.msgCount
      });
    }
    return {
      groups,
      hosts,
      summary: {
        groups: groups.length,
        edgeNodes: edgeCount,
        devices: deviceCount,
        hosts: hosts.length,
        online: onlineCount,
        lastUpdate: this.lastUpdate,
        // Surface the safety bounds when they bite, so truncation is visible
        // rather than silent.
        ...(this.droppedEndpoints ? { droppedEndpoints: this.droppedEndpoints } : {}),
        ...(this.metricOverflows ? { metricOverflows: this.metricOverflows } : {})
      }
    };
  }

  isEmpty() {
    return this.groups.size === 0 && this.hosts.size === 0;
  }
}

module.exports = SparkplugRegistry;
