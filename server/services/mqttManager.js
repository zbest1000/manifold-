const mqtt = require('mqtt');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const SparkplugDecoder = require('./sparkplugDecoder');

const MAX_MESSAGES_PER_TOPIC = 500;
const STATS_INTERVAL_MS = 2000;
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

class MqttManager extends EventEmitter {
  constructor(io) {
    super();
    this.io = io;
    this.connections = new Map(); // brokerId -> connection info
    this.clients = new Map(); // brokerId -> mqtt client
    this.topicData = new Map(); // brokerId -> Map(topic -> messages[])
    this.subscriptions = new Map(); // brokerId -> Set(topic filters)
    this.sparkplugDecoder = new SparkplugDecoder();

    this.cleanupTimer = setInterval(() => this.cleanupOldMessages(), 300000);
    this.statsTimer = setInterval(() => this.emitStats(), STATS_INTERVAL_MS);
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

    if (!topicMap.has(topic)) {
      topicMap.set(topic, []);
      info.metrics.topicCount = topicMap.size;
    }
    const topicMessages = topicMap.get(topic);
    topicMessages.push(messageObj);
    if (topicMessages.length > MAX_MESSAGES_PER_TOPIC) {
      topicMessages.splice(0, topicMessages.length - MAX_MESSAGES_PER_TOPIC);
    }

    this.io.emit('mqtt-message', messageObj);
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
      stats.push({ brokerId, status: info.status, metrics: { ...info.metrics }, lastActivity: info.lastActivity });
    });
    this.io.emit('broker-stats', stats);
  }

  cleanupOldMessages() {
    const cutoff = Date.now() - MESSAGE_TTL_MS;
    this.topicData.forEach((topicMap) => {
      topicMap.forEach((messages, topic) => {
        const kept = messages.filter((msg) => new Date(msg.timestamp).getTime() > cutoff);
        topicMap.set(topic, kept);
      });
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

  getTopics(brokerId) {
    const topicMap = this.topicData.get(brokerId);
    if (!topicMap) return [];

    const topics = [];
    topicMap.forEach((messages, topic) => {
      const last = messages[messages.length - 1];
      topics.push({
        topic,
        messageCount: messages.length,
        lastActivity: last?.timestamp || null,
        lastPayloadFormat: last?.payloadFormat || null,
        type: last?.type || 'unknown'
      });
    });
    return topics;
  }

  getMessages(brokerId, topic, limit = 50) {
    const topicMap = this.topicData.get(brokerId);
    if (!topicMap || !topicMap.has(topic)) return [];
    return topicMap.get(topic).slice(-limit);
  }

  shutdown() {
    clearInterval(this.cleanupTimer);
    clearInterval(this.statsTimer);
    this.clients.forEach((client) => client.end(true));
    this.clients.clear();
    this.connections.clear();
    this.topicData.clear();
  }
}

module.exports = MqttManager;
