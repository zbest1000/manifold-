'use strict';

const { compiledView } = require('./mqttMatch');

/**
 * Tag bindings — the bridge from "browse a device's tags" to "they live in the
 * UNS". A binding selects tags from a driver source and publishes their values
 * to a UNS destination:
 *
 *   source: { type: 'opcua', connectionId, samplingInterval?,
 *             tags: [{ address: <nodeId>, name }] }
 *         | { type: 'sparkplug', brokerId, group, edge, device?,
 *             metrics?: [names]   // omitted = all metrics of the endpoint
 *           }
 *   target: { mode: 'mqtt', brokerId, pathTemplate ('site/area/{name}'),
 *             format: 'plain' | 'envelope', qos?, retain?, deadband? }
 *         | { mode: 'sparkplug', brokerId, group, edge, device }
 *
 * (MQTT-source tags don't come through here — the wizard compiles those into
 * pipeline routes, which already do this job.)
 *
 * Semantics the industry expects and this enforces:
 * - Report-by-exception: an absolute `deadband` suppresses numeric changes
 *   smaller than the band; non-numeric values publish on change only.
 * - Quality propagation: OPC UA status codes map to OPC quality (Good=192,
 *   Uncertain=64, Bad=0) and ride along in `envelope` format; Sparkplug
 *   republishes carry Good (the certificate model already covers liveness).
 * - Read-only: bindings never write to a device. There is deliberately no
 *   write path in this engine.
 */

function opcQuality(status) {
  const s = String(status || '');
  if (s.startsWith('Good')) return 192;
  if (s.startsWith('Uncertain')) return 64;
  return 0;
}

function slug(name) {
  return String(name).trim().replace(/[\s/+#]+/g, '_');
}

function targetTopic(template, tagName) {
  const t = String(template || 'uns/{name}');
  return t.includes('{name}') ? t.replace(/\{name\}/g, slug(tagName)) : `${t.replace(/\/+$/, '')}/${slug(tagName)}`;
}

class TagBindings {
  constructor({ mqttManager, opcuaManager, profiles, sparkplugPublisher }) {
    this.manager = mqttManager;
    this.opcua = opcuaManager;
    this.profiles = profiles;
    this.spb = sparkplugPublisher;
    this.status = new Map(); // bindingId -> { published, suppressed, errors, lastError, lastTs }
    this.last = new Map(); // `${bindingId} ${tagName}` -> last published value
    this.monitored = new Set(); // `${connectionId} ${nodeId}` monitor requests already made
    this.onOpcuaValue = this.onOpcuaValue.bind(this);
    this.onMessage = this.onMessage.bind(this);
    this.started = false;

    // Compiled indexes, rebuilt on profile-store revision change.
    this.opcuaIndex = compiledView(profiles, () => {
      const idx = new Map(); // `${connectionId} ${nodeId}` -> [{ binding, tag }]
      for (const b of this.profiles.listIn('bindings')) {
        if (b.enabled === false || b.source?.type !== 'opcua') continue;
        for (const tag of b.source.tags || []) {
          const key = `${b.source.connectionId} ${tag.address}`;
          if (!idx.has(key)) idx.set(key, []);
          idx.get(key).push({ binding: b, tag });
        }
      }
      return idx;
    });
    this.spIndex = compiledView(profiles, () =>
      this.profiles.listIn('bindings').filter((b) => b.enabled !== false && b.source?.type === 'sparkplug')
    );
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.opcua?.on('value', this.onOpcuaValue);
    this.manager.on('message', this.onMessage);
    this.syncMonitors();
  }

  stop() {
    this.opcua?.off?.('value', this.onOpcuaValue);
    this.manager.off('message', this.onMessage);
    this.started = false;
  }

  _status(id) {
    let s = this.status.get(id);
    if (!s) {
      s = { published: 0, suppressed: 0, errors: 0, lastError: null, lastTs: 0 };
      this.status.set(id, s);
    }
    return s;
  }

  /** Ensure every OPC UA tag in an enabled binding has a monitored item. */
  async syncMonitors() {
    for (const b of this.profiles.listIn('bindings')) {
      if (b.enabled === false || b.source?.type !== 'opcua') continue;
      const interval = Number(b.source.samplingInterval) > 0 ? Number(b.source.samplingInterval) : 1000;
      for (const tag of b.source.tags || []) {
        const key = `${b.source.connectionId} ${tag.address}`;
        if (this.monitored.has(key)) continue;
        this.monitored.add(key);
        try {
          await this.opcua.monitor(b.source.connectionId, tag.address, interval);
        } catch (error) {
          this.monitored.delete(key); // retry on next sync
          this._status(b.id).lastError = `monitor ${tag.address}: ${error.message}`;
        }
      }
    }
  }

  onOpcuaValue(evt) {
    const hits = this.opcuaIndex().get(`${evt.connectionId} ${evt.nodeId}`);
    if (!hits) return;
    const ts = new Date(evt.sourceTimestamp || Date.now()).getTime() || Date.now();
    for (const { binding, tag } of hits) {
      this._publishTag(binding, tag.name || tag.address, evt.value, opcQuality(evt.status), ts);
    }
  }

  onMessage(msg) {
    const bindings = this.spIndex();
    if (!bindings.length || !msg.sparkplug || !Array.isArray(msg.sparkplug.metrics)) return;
    // Topic: spBv1.0/{group}/{type}/{edge}[/{device}]
    const parts = msg.topicParts || msg.topic.split('/');
    if (parts[0] !== 'spBv1.0' || !/^(N|D)(DATA|BIRTH)$/.test(parts[2] || '')) return;
    const [, group, , edge, device = null] = parts;

    for (const b of bindings) {
      const src = b.source;
      if (src.brokerId !== msg.brokerId || src.group !== group || src.edge !== edge) continue;
      if (src.device && src.device !== device) continue;
      const wanted = Array.isArray(src.metrics) && src.metrics.length ? new Set(src.metrics) : null;
      for (const m of msg.sparkplug.metrics) {
        if (!m || m.name === undefined || m.name === null) continue;
        if (wanted && !wanted.has(m.name)) continue;
        this._publishTag(b, m.name, m.value, 192, new Date(msg.timestamp).getTime() || Date.now());
      }
    }
  }

  _publishTag(binding, tagName, value, quality, ts) {
    const s = this._status(binding.id);
    const target = binding.target || {};
    const key = `${binding.id} ${tagName}`;
    const prev = this.last.get(key);

    // Report by exception: deadband for numerics, on-change for the rest.
    const band = Number(target.deadband) || 0;
    if (prev !== undefined) {
      if (typeof value === 'number' && typeof prev === 'number' && band > 0) {
        if (Math.abs(value - prev) < band) {
          s.suppressed++;
          return;
        }
      } else if (value === prev) {
        s.suppressed++;
        return;
      }
    }
    this.last.set(key, value);
    s.lastTs = Date.now();

    if (target.mode === 'sparkplug') {
      try {
        this.spb.updateDevice({
          brokerId: target.brokerId,
          group: target.group,
          edge: target.edge,
          device: target.device || slug(binding.name || binding.id),
          metrics: [{ name: tagName, value, ts }]
        });
        s.published++;
      } catch (error) {
        s.errors++;
        s.lastError = error.message;
      }
      return;
    }

    // mqtt target
    const topic = targetTopic(target.pathTemplate, tagName);
    const payload = target.format === 'envelope' ? { v: value, t: ts, q: quality } : value;
    this.manager
      .publish(target.brokerId, topic, payload, { qos: target.qos || 0, retain: Boolean(target.retain) })
      .then(() => {
        s.published++;
      })
      .catch((error) => {
        s.errors++;
        s.lastError = error.message;
      });
  }

  getStatus() {
    return Object.fromEntries(this.status);
  }
}

module.exports = { TagBindings, opcQuality, targetTopic, slug };
