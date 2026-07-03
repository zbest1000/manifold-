const mqtt = require('mqtt');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const SparkplugDecoder = require('./sparkplugDecoder');

const STATS_INTERVAL_MS = 2000;
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

// Memory-safe model for brokers with up to millions of topics: keep only a
// latest-value record per topic (O(topics), small constant) plus a bounded
// global ring of recent messages for the detail view — never an unbounded
// history per topic. Socket forwarding is batched so the initial retained
// burst of a huge broker doesn't emit millions of individual events.
const MAX_TOPICS = 2_000_000; // per-broker topic cap (guards server memory)
const GLOBAL_RECENT = 5000; // recent messages kept across all topics, per broker
const EMIT_BATCH_MS = 100; // flush forwarded messages on this cadence
const EMIT_BATCH_MAX = 2000; // …or early once this many are pending

class MqttManager extends EventEmitter {
  constructor(io) {
    super();
    this.io = io;
    this.connections = new Map(); // brokerId -> connection info
    this.clients = new Map(); // brokerId -> mqtt client
    this.topicData = new Map(); // brokerId -> Map(topic -> latest-value record)
    this.recent = new Map(); // brokerId -> recent message ring (bounded)
    this.pending = new Map(); // brokerId -> messages awaiting a batched emit
    this.dropped = new Map(); // brokerId -> count of topics dropped at the cap
    this.subscriptions = new Map(); // brokerId -> Set(topic filters)
    this.sparkplugDecoder = new SparkplugDecoder();

    // unref so these background timers never keep the process alive on their own
    // (the HTTP server holds the event loop open in normal operation)
    this.cleanupTimer = setInterval(() => this.cleanupOldMessages(), 300000);
    this.statsTimer = setInterval(() => this.emitStats(), STATS_INTERVAL_MS);
    this.batchTimer = setInterval(() => this.flushBatches(), EMIT_BATCH_MS);
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
    this.topicData.set(brokerId, new Map());
    this.recent.set(brokerId, []);
    this.pending.set(brokerId, []);
    this.dropped.set(brokerId, 0);
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

  handleMessage(brokerId, topic, message, packet) {
    const info = this.connections.get(brokerId);
    const topicMap = this.topicData.get(brokerId);
    if (!info || !topicMap) return;

    info.metrics.messagesReceived++;
    info.metrics.bytesReceived += message.length;
    info.lastActivity = new Date();

    let payload;
    let payloadFormat = 'text';
    const text = message.toString('utf8');
    try {
      payload = JSON.parse(text);
      payloadFormat = 'json';
    } catch {
      // Non-UTF8 payloads decode to replacement chars; flag them as binary
      payload = text;
      if (/�/.test(text)) {
        payloadFormat = 'binary';
        payload = message.toString('base64');
      }
    }

    const messageObj = {
      id: uuidv4(),
      brokerId,
      topic,
      payload,
      payloadFormat,
      qos: packet.qos,
      retain: packet.retain,
      timestamp: new Date().toISOString(),
      size: message.length,
      type: this.detectMessageType(topic, payload)
    };

    if (this.isSparkplugTopic(topic)) {
      try {
        messageObj.sparkplug = this.sparkplugDecoder.decode(message);
        messageObj.type = 'sparkplug';
      } catch (error) {
        messageObj.sparkplugError = error.message;
      }
    }

    // Latest-value record per topic (O(1), bounded memory even at millions of
    // topics). New topics past the cap are still forwarded to clients but not
    // retained server-side, so memory can't grow without bound.
    let record = topicMap.get(topic);
    if (!record) {
      if (topicMap.size >= MAX_TOPICS) {
        this.dropped.set(brokerId, (this.dropped.get(brokerId) || 0) + 1);
      } else {
        record = { topic, messageCount: 0, firstSeen: messageObj.timestamp };
        topicMap.set(topic, record);
        info.metrics.topicCount = topicMap.size;
      }
    }
    if (record) {
      record.messageCount++;
      record.lastActivity = messageObj.timestamp;
      record.type = messageObj.type;
      record.retain = messageObj.retain;
      record.payloadFormat = messageObj.payloadFormat;
      record.latest = messageObj;
    }

    // Bounded global ring for the detail view's recent history.
    const ring = this.recent.get(brokerId);
    if (ring) {
      ring.push(messageObj);
      if (ring.length > GLOBAL_RECENT) ring.splice(0, ring.length - GLOBAL_RECENT);
    }

    // Queue for a batched socket emit (flush on cadence or when large).
    const pending = this.pending.get(brokerId);
    if (pending) {
      pending.push(messageObj);
      if (pending.length >= EMIT_BATCH_MAX) this.flushBroker(brokerId);
    }
  }

  flushBroker(brokerId) {
    const pending = this.pending.get(brokerId);
    if (!pending || pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    this.io.emit('mqtt-messages', batch);
  }

  flushBatches() {
    for (const brokerId of this.pending.keys()) this.flushBroker(brokerId);
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
    this.topicData.delete(brokerId);
    this.recent.delete(brokerId);
    this.pending.delete(brokerId);
    this.dropped.delete(brokerId);
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
        metrics: { ...info.metrics, droppedTopics: this.dropped.get(brokerId) || 0 },
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
    const topicMap = this.topicData.get(brokerId);
    if (!topicMap) return { topics: [], total: 0, dropped: 0 };

    const topics = [];
    for (const record of topicMap.values()) {
      if (topics.length >= limit) break;
      topics.push({
        topic: record.topic,
        messageCount: record.messageCount,
        lastActivity: record.lastActivity || null,
        lastPayloadFormat: record.payloadFormat || null,
        type: record.type || 'unknown',
        retain: record.retain || false,
        payload: record.latest?.payload
      });
    }
    return { topics, total: topicMap.size, dropped: this.dropped.get(brokerId) || 0 };
  }

  getMessages(brokerId, topic, limit = 50) {
    const ring = this.recent.get(brokerId) || [];
    const matches = [];
    // Walk newest→oldest so the most recent messages for the topic come first.
    for (let i = ring.length - 1; i >= 0 && matches.length < limit; i--) {
      if (ring[i].topic === topic) matches.push(ring[i]);
    }
    // Ensure the retained latest value is present even if it aged out of the ring.
    const record = this.topicData.get(brokerId)?.get(topic);
    if (record?.latest && !matches.some((m) => m.id === record.latest.id)) {
      matches.push(record.latest);
    }
    return matches.reverse();
  }

  shutdown() {
    clearInterval(this.cleanupTimer);
    clearInterval(this.statsTimer);
    clearInterval(this.batchTimer);
    this.clients.forEach((client) => client.end(true));
    this.clients.clear();
    this.connections.clear();
    this.topicData.clear();
    this.recent.clear();
    this.pending.clear();
  }
}

module.exports = MqttManager;
