const mqtt = require('mqtt');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const SparkplugDecoder = require('./sparkplugDecoder');
const SparkplugRegistry = require('./sparkplugRegistry');
const TopicStore = require('./topicStore');
const brokerAdmin = require('./brokerAdmin');

const STATS_INTERVAL_MS = 2000;
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

// Memory-safe model for brokers with up to millions of topics: keep only a
// latest-value record per topic (O(topics), small constant) plus a bounded
// global ring of recent messages for the detail view — never an unbounded
// history per topic. Socket forwarding is batched so the initial retained
// burst of a huge broker doesn't emit millions of individual events.
const MAX_TOPICS = 2_000_000; // per-broker topic cap (guards server memory)
const GLOBAL_RECENT = 5000; // recent messages kept across all topics, per broker
const FLUSH_MS = 100; // coalesce + forward on this cadence
const FORWARD_CAP = 5000; // max topics forwarded per flush (sample beyond this)

class MqttManager extends EventEmitter {
  constructor(io) {
    super();
    this.io = io;
    this.connections = new Map(); // brokerId -> connection info
    this.clients = new Map(); // brokerId -> mqtt client
    this.stores = new Map(); // brokerId -> TopicStore (memory-lean struct-of-arrays)
    this.sparkplug = new Map(); // brokerId -> SparkplugRegistry (device topology)
    this.admin = new Map(); // brokerId -> broker admin API config (per-client subs)
    this.recent = new Map(); // brokerId -> recent message ring (bounded)
    this.msgSeq = 0; // fast monotonic id (avoids uuid per message on the hot path)
    this.subscriptions = new Map(); // brokerId -> Set(topic filters)
    this.sparkplugDecoder = new SparkplugDecoder();

    // unref so these background timers never keep the process alive on their own
    // (the HTTP server holds the event loop open in normal operation)
    this.cleanupTimer = setInterval(() => this.cleanupOldMessages(), 300000);
    this.statsTimer = setInterval(() => this.emitStats(), STATS_INTERVAL_MS);
    this.batchTimer = setInterval(() => this.flushBatches(), FLUSH_MS);
    this.cleanupTimer.unref?.();
    this.statsTimer.unref?.();
    this.batchTimer.unref?.();
  }

  connectToBroker(config = {}) {
    if (!config.host) {
      throw new Error('host is required');
    }

    const brokerId = config.id || uuidv4();
    if (this.clients.has(brokerId)) {
      throw new Error(`Broker ${brokerId} is already connected`);
    }

    const port = Number(config.port) || (config.protocol === 'mqtts' ? 8883 : 1883);
    const protocol = config.protocol || (port === 8883 ? 'mqtts' : 'mqtt');
    const clientId = config.clientId || `topic-canvas_${Date.now()}`;
    const brokerUrl = `${protocol}://${config.host}:${port}`;

    const options = {
      clientId,
      keepalive: config.keepalive || 60,
      connectTimeout: config.timeout || 15000,
      reconnectPeriod: config.reconnect === false ? 0 : 5000,
      clean: config.cleanSession !== false,
      rejectUnauthorized: config.rejectUnauthorized !== false
    };

    if (config.username) {
      options.username = config.username;
      options.password = config.password || '';
    }
    if (protocol === 'mqtts') {
      if (config.ca) options.ca = config.ca;
      if (config.cert) options.cert = config.cert;
      if (config.key) options.key = config.key;
    }

    const client = mqtt.connect(brokerUrl, options);

    const info = {
      id: brokerId,
      name: config.name || `${config.host}:${port}`,
      host: config.host,
      port,
      protocol,
      clientId,
      username: config.username || null,
      autoSubscribe: config.autoSubscribe !== false,
      status: 'connecting',
      connectedAt: null,
      lastActivity: new Date(),
      lastError: null,
      metrics: {
        messagesReceived: 0,
        messagesSent: 0,
        bytesReceived: 0,
        bytesSent: 0,
        topicCount: 0,
        errors: 0
      }
    };

    this.connections.set(brokerId, info);
    this.clients.set(brokerId, client);
    this.stores.set(brokerId, new TopicStore(MAX_TOPICS));
    this.sparkplug.set(brokerId, new SparkplugRegistry());
    this.recent.set(brokerId, []);
    this.subscriptions.set(brokerId, new Set());
    this.setupClientEventHandlers(client, brokerId);

    this.io.emit('mqtt-connection-attempt', { brokerId, connection: this.publicInfo(info) });
    return { brokerId, status: 'connecting' };
  }

  setupClientEventHandlers(client, brokerId) {
    const info = this.connections.get(brokerId);

    client.on('connect', () => {
      info.status = 'connected';
      info.connectedAt = new Date();
      info.lastError = null;
      this.io.emit('mqtt-connected', { brokerId, connection: this.publicInfo(info) });

      if (info.autoSubscribe) {
        this.subscribe(brokerId, '#', 0);
        // `#` does not match topics beginning with `$` (MQTT spec), so subscribe
        // to the broker's `$SYS` tree separately for audit/health stats. Brokers
        // that don't publish `$SYS` simply deliver nothing here.
        this.subscribe(brokerId, '$SYS/#', 0);
      }
    });

    client.on('message', (topic, message, packet) => {
      this.handleMessage(brokerId, topic, message, packet);
    });

    client.on('error', (error) => {
      info.status = 'error';
      info.lastError = error.message;
      info.metrics.errors++;
      this.io.emit('mqtt-error', { brokerId, error: error.message });
    });

    client.on('close', () => {
      if (info.status !== 'disconnected') {
        info.status = 'offline';
        this.io.emit('mqtt-offline', { brokerId });
      }
    });

    client.on('reconnect', () => {
      info.status = 'reconnecting';
      this.io.emit('mqtt-reconnecting', { brokerId });
    });
  }

  // Hot path — runs once per publish. Kept deliberately minimal so the manager
  // can sustain very high publish rates (millions/sec): no JSON parse, no uuid,
  // no per-message allocation of a message object. The store keeps only the
  // latest payload per topic (as a latin1 string in a struct-of-arrays) and marks
  // the topic dirty; the actual message object is built once per topic at flush
  // time (coalescing). See topicStore.js for the memory model.
  handleMessage(brokerId, topic, message, packet) {
    const info = this.connections.get(brokerId);
    const store = this.stores.get(brokerId);
    if (!info || !store) return;

    info.metrics.messagesReceived++;
    info.metrics.bytesReceived += message.length;

    store.ingest(topic, message, packet.qos, packet.retain);
    info.metrics.topicCount = store.topicCount();
  }

  // Build the full message object for a drained topic row (parse, type
  // detection, Sparkplug decode). Runs at most once per topic per flush.
  // `row` is a TopicStore row: { topic, buffer, qos, retain, ts, count }.
  buildMessage(brokerId, row) {
    const message = row.buffer;
    let payload;
    let payloadFormat = 'text';
    const text = message.toString('utf8');
    try {
      payload = JSON.parse(text);
      payloadFormat = 'json';
    } catch {
      payload = text;
      if (/�/.test(text)) {
        payloadFormat = 'binary';
        payload = message.toString('base64');
      }
    }

    const messageObj = {
      id: ++this.msgSeq,
      brokerId,
      topic: row.topic,
      payload,
      payloadFormat,
      qos: row.qos,
      retain: row.retain,
      timestamp: new Date(row.ts).toISOString(),
      size: message.length,
      type: this.detectMessageType(row.topic, payload)
    };

    if (this.isSparkplugTopic(row.topic)) {
      try {
        messageObj.sparkplug = this.sparkplugDecoder.decode(message);
        messageObj.type = 'sparkplug';
      } catch (error) {
        messageObj.sparkplugError = error.message;
      }
    }
    return messageObj;
  }

  // Coalesce: for every topic touched since the last flush, build ONE message
  // (its latest value) and forward that. A topic hammered a million times in the
  // flush window produces a single forwarded update, so socket + client load is
  // bounded by the number of *topics* touched, not the publish rate. Beyond
  // FORWARD_CAP topics per flush we forward a sample (server still counts all).
  flushBroker(brokerId) {
    const store = this.stores.get(brokerId);
    if (!store) return;

    const rows = store.drain();
    if (rows.length === 0) return;

    const ring = this.recent.get(brokerId);
    const registry = this.sparkplug.get(brokerId);
    const batch = [];
    let forwarded = 0;
    let lastActivity = null;

    for (const row of rows) {
      const messageObj = this.buildMessage(brokerId, row);
      lastActivity = messageObj.timestamp;

      // Fold Sparkplug traffic into the device topology (identity from the topic,
      // metrics from the decoded payload). Reuses the decode already done above.
      if (registry && this.isSparkplugTopic(messageObj.topic)) {
        registry.update(messageObj.topic, messageObj.sparkplug || null, row.ts);
      }

      if (forwarded < FORWARD_CAP) {
        batch.push(messageObj);
        forwarded++;
        if (ring) {
          ring.push(messageObj);
          if (ring.length > GLOBAL_RECENT) ring.splice(0, ring.length - GLOBAL_RECENT);
        }
      }
    }

    const info = this.connections.get(brokerId);
    if (info && lastActivity) info.lastActivity = new Date(lastActivity);

    if (batch.length) this.io.emit('mqtt-messages', batch);
  }

  flushBatches() {
    for (const brokerId of this.stores.keys()) this.flushBroker(brokerId);
  }

  subscribe(brokerId, topic, qos = 0) {
    const client = this.requireClient(brokerId);
    client.subscribe(topic, { qos }, (error, granted) => {
      if (error) {
        this.io.emit('subscription-error', { brokerId, topic, error: error.message });
        return;
      }
      this.subscriptions.get(brokerId)?.add(topic);
      this.io.emit('subscription-success', { brokerId, topic, qos, granted });
    });
  }

  unsubscribe(brokerId, topic) {
    const client = this.requireClient(brokerId);
    client.unsubscribe(topic, (error) => {
      if (error) {
        this.io.emit('unsubscription-error', { brokerId, topic, error: error.message });
        return;
      }
      this.subscriptions.get(brokerId)?.delete(topic);
      this.io.emit('unsubscription-success', { brokerId, topic });
    });
  }

  publish(brokerId, topic, payload, options = {}) {
    const client = this.requireClient(brokerId);
    const info = this.connections.get(brokerId);
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      client.publish(topic, body, { qos: options.qos || 0, retain: options.retain || false }, (error) => {
        if (error) {
          info.metrics.errors++;
          this.io.emit('publish-error', { brokerId, topic, error: error.message });
          return reject(error);
        }
        info.metrics.messagesSent++;
        info.metrics.bytesSent += body.length;
        info.lastActivity = new Date();
        this.io.emit('publish-success', { brokerId, topic, timestamp: new Date().toISOString() });
        resolve({ brokerId, topic, size: body.length });
      });
    });
  }

  disconnectFromBroker(brokerId) {
    const client = this.clients.get(brokerId);
    const info = this.connections.get(brokerId);
    if (!client && !info) {
      throw new Error(`Unknown broker ${brokerId}`);
    }

    if (info) info.status = 'disconnected';
    if (client) {
      client.end(true);
      this.clients.delete(brokerId);
    }
    this.connections.delete(brokerId);
    this.stores.delete(brokerId);
    this.sparkplug.delete(brokerId);
    this.admin.delete(brokerId);
    this.recent.delete(brokerId);
    this.subscriptions.delete(brokerId);
    this.io.emit('mqtt-disconnected', { brokerId });
    return { brokerId, status: 'disconnected' };
  }

  requireClient(brokerId) {
    const client = this.clients.get(brokerId);
    const info = this.connections.get(brokerId);
    if (!client || !info || info.status !== 'connected') {
      throw new Error(`Broker ${brokerId} is not connected`);
    }
    return client;
  }

  detectMessageType(topic, payload) {
    if (this.isSparkplugTopic(topic)) return 'sparkplug';
    const lower = topic.toLowerCase();
    if (lower.includes('alarm') || lower.includes('alert')) return 'alarm';
    if (lower.includes('command') || lower.includes('/cmd')) return 'command';
    if (lower.includes('config') || lower.includes('settings')) return 'configuration';
    if (lower.includes('telemetry') || lower.includes('sensor') || lower.includes('status')) return 'telemetry';
    if (typeof payload === 'object' && payload !== null) return 'json';
    return 'text';
  }

  isSparkplugTopic(topic) {
    return topic.startsWith('spBv1.0/') ||
      /\/(N|D)(BIRTH|DEATH|DATA|CMD)\//.test(`/${topic}/`);
  }

  emitStats() {
    if (this.connections.size === 0) return;
    const stats = [];
    this.connections.forEach((info, brokerId) => {
      stats.push({
        brokerId,
        status: info.status,
        metrics: { ...info.metrics, droppedTopics: this.stores.get(brokerId)?.dropped || 0 },
        lastActivity: info.lastActivity
      });
    });
    this.io.emit('broker-stats', stats);
  }

  cleanupOldMessages() {
    const cutoff = Date.now() - MESSAGE_TTL_MS;
    this.recent.forEach((ring, brokerId) => {
      this.recent.set(
        brokerId,
        ring.filter((msg) => new Date(msg.timestamp).getTime() > cutoff)
      );
    });
  }

  publicInfo(info) {
    const { metrics, ...rest } = info;
    return { ...rest, metrics: { ...metrics } };
  }

  getConnections() {
    return Array.from(this.connections.values()).map((info) => this.publicInfo(info));
  }

  getConnection(brokerId) {
    const info = this.connections.get(brokerId);
    return info ? this.publicInfo(info) : null;
  }

  getSubscriptions(brokerId) {
    return Array.from(this.subscriptions.get(brokerId) || []);
  }

  getTopics(brokerId, { limit = Infinity } = {}) {
    const store = this.stores.get(brokerId);
    if (!store) return { topics: [], total: 0, dropped: 0 };

    const topics = store.getTopics(limit).map((row) => {
      const msg = this.buildMessage(brokerId, row);
      return {
        topic: row.topic,
        messageCount: row.count,
        lastActivity: msg.timestamp,
        lastPayloadFormat: msg.payloadFormat,
        type: msg.type,
        retain: msg.retain,
        payload: msg.payload
      };
    });
    return { topics, total: store.topicCount(), dropped: store.dropped };
  }

  getMessages(brokerId, topic, limit = 50) {
    const ring = this.recent.get(brokerId) || [];
    const matches = [];
    // Walk newest→oldest so the most recent messages for the topic come first.
    for (let i = ring.length - 1; i >= 0 && matches.length < limit; i--) {
      if (ring[i].topic === topic) matches.push(ring[i]);
    }
    // The newest ring hit for a topic is already its latest value; only when the
    // topic has aged entirely out of the ring do we rebuild it from the store.
    if (matches.length === 0) {
      const row = this.stores.get(brokerId)?.getLatest(topic);
      if (row) matches.push(this.buildMessage(brokerId, row));
    }
    return matches.reverse();
  }

  // Sparkplug B device topology: real publishing endpoints (Group → Edge Node →
  // Device) with online/offline state and each endpoint's metric set.
  getSparkplug(brokerId) {
    const registry = this.sparkplug.get(brokerId);
    return registry ? registry.toJSON() : { groups: [], summary: { groups: 0, edgeNodes: 0, devices: 0, online: 0, lastUpdate: 0 } };
  }

  // Broker `$SYS` stats (Mosquitto/EMQX-style). Returns the raw latest values plus
  // a curated summary. Aggregate only — standard `$SYS` exposes broker health and
  // client/subscription COUNTS, not a per-client subscription map (see routes).
  getSysStats(brokerId) {
    const store = this.stores.get(brokerId);
    if (!store) return { available: false, raw: {}, summary: {} };
    const rows = store.getByPrefix('$SYS/');
    if (!rows.length) return { available: false, raw: {}, summary: {} };

    const raw = {};
    for (const row of rows) raw[row.topic] = row.buffer.toString('utf8');
    const num = (t) => {
      const v = parseFloat(raw[t]);
      return Number.isFinite(v) ? v : undefined;
    };
    const summary = {
      version: raw['$SYS/broker/version'],
      uptimeSeconds: num('$SYS/broker/uptime'),
      clientsConnected: num('$SYS/broker/clients/connected') ?? num('$SYS/broker/clients/active'),
      clientsTotal: num('$SYS/broker/clients/total'),
      clientsMaximum: num('$SYS/broker/clients/maximum'),
      subscriptionsCount: num('$SYS/broker/subscriptions/count'),
      messagesReceived: num('$SYS/broker/messages/received'),
      messagesSent: num('$SYS/broker/messages/sent'),
      bytesReceived: num('$SYS/broker/bytes/received'),
      bytesSent: num('$SYS/broker/bytes/sent'),
      retainedMessages: num('$SYS/broker/retained messages/count') ?? num('$SYS/broker/messages/retained/count'),
      loadMessagesReceived1min: num('$SYS/broker/load/messages/received/1min')
    };
    return { available: true, raw, summary };
  }

  // Broker admin API config (per-client subscription source). The secret is kept
  // server-side and never echoed back.
  setBrokerAdmin(brokerId, config = {}) {
    if (!this.connections.has(brokerId)) throw new Error(`Unknown broker ${brokerId}`);
    if (!config.url) throw new Error('admin url is required');
    this.admin.set(brokerId, {
      type: config.type || 'emqx',
      url: config.url,
      apiKey: config.apiKey || '',
      apiSecret: config.apiSecret || ''
    });
    return this.getBrokerAdmin(brokerId);
  }

  getBrokerAdmin(brokerId) {
    const cfg = this.admin.get(brokerId);
    if (!cfg) return { configured: false };
    return { configured: true, type: cfg.type, url: cfg.url, hasKey: Boolean(cfg.apiKey) };
  }

  clearBrokerAdmin(brokerId) {
    this.admin.delete(brokerId);
    return { configured: false };
  }

  async fetchAdminPubSub(brokerId) {
    const cfg = this.admin.get(brokerId);
    if (!cfg) {
      return { configured: false, source: null, clients: [], subscriptions: [] };
    }
    const result = await brokerAdmin.fetchPubSub(cfg);
    return { configured: true, ...result };
  }

  shutdown() {
    clearInterval(this.cleanupTimer);
    clearInterval(this.statsTimer);
    clearInterval(this.batchTimer);
    this.clients.forEach((client) => client.end(true));
    this.clients.clear();
    this.connections.clear();
    this.stores.clear();
    this.sparkplug.clear();
    this.admin.clear();
    this.recent.clear();
  }
}

module.exports = MqttManager;
