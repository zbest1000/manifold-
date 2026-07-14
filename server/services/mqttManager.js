const mqtt = require('mqtt');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const SparkplugDecoder = require('./sparkplugDecoder');
const SparkplugRegistry = require('./sparkplugRegistry');
const TopicStore = require('./topicStore');
const TopicTrie = require('./topicTrie');
const brokerAdmin = require('./brokerAdmin');
const { lintTrie } = require('./unsLint');

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
    this.tries = new Map(); // brokerId -> { trie, indexedThrough } (lazy; built on first resolve)
    this.sys = new Map(); // brokerId -> Set($SYS topic) — keeps /sys reads O(sys), not O(topics)
    this.recent = new Map(); // brokerId -> recent message ring (bounded)
    this.topicMeta = new Map(); // brokerId -> Array(slot -> {type, spark}) — a topic's classification never changes
    this.rowCache = new Map(); // brokerId -> Map(slot -> { count, row }) — read-path decode cache
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
    const clientId = config.clientId || `manifold_${Date.now()}`;
    const brokerUrl = `${protocol}://${config.host}:${port}`;

    const options = {
      clientId,
      keepalive: Number(config.keepalive) || 60,
      connectTimeout: Number(config.timeout) || 15000,
      reconnectPeriod: config.reconnect === false ? 0 : Number(config.reconnectPeriod) || 5000,
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
      // Intake durability: QoS 0 subscriptions silently shed messages under
      // broker pressure — no pipeline can be more reliable than its intake, so
      // the explorer subscription defaults to QoS 1.
      subscribeQos: [0, 1, 2].includes(Number(config.subscribeQos)) ? Number(config.subscribeQos) : 1,
      // 0 = reconnect forever (mqtt.js default); >0 = give up after N attempts.
      maxReconnect: Number(config.maxReconnect) > 0 ? Number(config.maxReconnect) : 0,
      reconnectCount: 0,
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
    this.topicMeta.set(brokerId, []);
    this.sparkplug.set(brokerId, new SparkplugRegistry());
    this.sys.set(brokerId, new Set());
    this.recent.set(brokerId, []);
    this.rowCache.set(brokerId, new Map());
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
      info.reconnectCount = 0; // a successful connect resets the retry counter
      this.io.emit('mqtt-connected', { brokerId, connection: this.publicInfo(info) });

      if (info.autoSubscribe) {
        this.subscribe(brokerId, '#', info.subscribeQos);
        // `#` does not match topics beginning with `$` (MQTT spec), so subscribe
        // to the broker's `$SYS` tree separately for audit/health stats. Brokers
        // that don't publish `$SYS` simply deliver nothing here ($SYS stays QoS 0
        // — it's periodic diagnostics, losing one sample is meaningless).
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
      // Keep an explicit 'error' (e.g. gave-up-after-max-retries) rather than
      // downgrading it to 'offline'.
      if (info.status !== 'disconnected' && info.status !== 'error') {
        info.status = 'offline';
        this.io.emit('mqtt-offline', { brokerId });
      }
    });

    client.on('reconnect', () => {
      info.reconnectCount = (info.reconnectCount || 0) + 1;
      if (info.maxReconnect && info.reconnectCount > info.maxReconnect) {
        info.status = 'error';
        info.lastError = `Gave up after ${info.maxReconnect} reconnect attempt(s)`;
        info.metrics.errors++;
        this.io.emit('mqtt-error', { brokerId, error: info.lastError });
        client.end(true);
        return;
      }
      info.status = 'reconnecting';
      this.io.emit('mqtt-reconnecting', { brokerId, attempt: info.reconnectCount });
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
    // One char-code check per message; $SYS traffic is low-rate and tracking the
    // set here keeps the /sys endpoint O(|$SYS|) instead of scanning every topic.
    if (topic.charCodeAt(0) === 36 /* '$' */ && topic.startsWith('$SYS/')) {
      this.sys.get(brokerId)?.add(topic);
    }
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
      if (text.includes('�')) {
        payloadFormat = 'binary';
        payload = message.toString('base64');
      }
    }

    // Topic classification is a pure function of the topic string — cache it
    // by slot instead of re-running the substring scans per flushed message.
    let meta;
    const metaArr = this.topicMeta.get(brokerId);
    if (metaArr && row.slot !== undefined) {
      meta = metaArr[row.slot];
      if (!meta) {
        meta = { type: this.detectMessageType(row.topic, payload), spark: this.isSparkplugTopic(row.topic) };
        metaArr[row.slot] = meta;
      }
    } else {
      meta = { type: this.detectMessageType(row.topic, payload), spark: this.isSparkplugTopic(row.topic) };
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
      type: meta.type === 'json' || meta.type === 'text' ? (typeof payload === 'object' && payload !== null ? 'json' : 'text') : meta.type
    };

    if (meta.spark) {
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

    const tap = this.listenerCount('message') > 0;
    for (const row of rows) {
      const messageObj = this.buildMessage(brokerId, row);
      // Split once here; every tap engine matches on segments.
      if (tap) messageObj.topicParts = messageObj.topic.split('/');
      lastActivity = messageObj.timestamp;

      // Fold Sparkplug traffic into the device topology (identity from the topic,
      // metrics from the decoded payload). Reuses the decode already done above.
      if (registry && this.isSparkplugTopic(messageObj.topic)) {
        registry.update(messageObj.topic, messageObj.sparkplug || null, row.ts);
      }

      // Message tap for the DataOps engines (pipelines, recorder, contracts,
      // models). Fires on the coalesced stream — bounded by topics touched per
      // flush, not raw publish rate — and costs one branch when nobody listens.
      if (tap) this.emit('message', messageObj);

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

    // Serializing the batch for zero sockets is pure waste (headless deploys,
    // MCP-only usage) — skip the emit when nobody is listening.
    if (batch.length && (this.io.engine?.clientsCount ?? 1) > 0) this.io.emit('mqtt-messages', batch);
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
      // A broker can accept the packet but refuse the grant (SUBACK 0x80).
      // Stock EMQX does exactly this for QoS 1+ subscriptions to bare '#'
      // (its default ACL allows them only at QoS 0) — without a fallback the
      // explorer would sit connected and silently ingest nothing.
      if (granted?.length && granted.every((g) => g.qos === 128)) {
        if (qos > 0) {
          this.io.emit('subscription-downgraded', {
            brokerId,
            topic,
            from: qos,
            to: 0,
            reason: 'broker refused the grant at this QoS (SUBACK 0x80) — retrying at QoS 0'
          });
          this.subscribe(brokerId, topic, 0);
        } else {
          this.io.emit('subscription-error', { brokerId, topic, error: 'subscription refused by broker (SUBACK 0x80)' });
        }
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
    this.topicMeta.delete(brokerId);
    this.sparkplug.delete(brokerId);
    this.admin.delete(brokerId);
    this.tries.delete(brokerId);
    this.sys.delete(brokerId);
    this.recent.delete(brokerId);
    this.rowCache.delete(brokerId);
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

    // Read-path decode cache: on large brokers most topics are idle between
    // snapshot calls (retained config, birth certificates, slow sensors), so the
    // JSON parse + type detection from the previous call is still valid. A row's
    // `count` increments on every ingest, making it a perfect version stamp:
    // cache the projected object per slot and reuse it while count is unchanged.
    const cache = this.rowCache.get(brokerId);
    const topics = store.getTopics(limit).map((row) => {
      const hit = cache?.get(row.slot);
      if (hit && hit.count === row.count) return hit.obj;
      const msg = this.buildMessage(brokerId, row);
      const obj = {
        topic: row.topic,
        messageCount: row.count,
        lastActivity: msg.timestamp,
        lastPayloadFormat: msg.payloadFormat,
        type: msg.type,
        retain: msg.retain,
        payload: msg.payload
      };
      cache?.set(row.slot, { count: row.count, obj });
      return obj;
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
    const sysTopics = this.sys.get(brokerId);
    if (!store || !sysTopics || sysTopics.size === 0) return { available: false, raw: {}, summary: {} };

    // O(|$SYS|): topics tracked at ingest, values read directly by slot.
    const raw = {};
    for (const topic of sysTopics) {
      const row = store.getLatest(topic);
      if (row) raw[topic] = row.buffer.toString('utf8');
    }
    if (Object.keys(raw).length === 0) return { available: false, raw: {}, summary: {} };
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

  // ---- Wildcard resolution: filters -> concrete observed topics ------------
  // A subscription filter is a query, not a destination; these methods answer
  // what a filter ACTUALLY matches against the live topic set. The trie is
  // deliberately kept off the ingest hot path: it is built lazily on first use
  // (O(topics) once) and caught up incrementally per call (O(new topics only),
  // via the store's monotonic slot -> topic array).

  getTrie(brokerId) {
    const store = this.stores.get(brokerId);
    if (!store) return null;
    let entry = this.tries.get(brokerId);
    if (!entry) {
      entry = { trie: new TopicTrie(), indexedThrough: 0 };
      this.tries.set(brokerId, entry);
    }
    for (let slot = entry.indexedThrough; slot < store.n; slot++) {
      const topic = store.topicAt(slot);
      if (topic !== undefined) entry.trie.insert(topic, slot);
    }
    entry.indexedThrough = store.n;
    return entry.trie;
  }

  /**
   * Resolve subscription filters against observed topics. Filters are deduped
   * (many clients typically share a handful). Sample rows are hydrated from the
   * store (ts / retain / msgCount). Counts are exact even when samples truncate.
   */
  resolveSubscriptions(brokerId, filters, { sampleLimit = 100, rootsLimit = 50 } = {}) {
    const store = this.stores.get(brokerId);
    const trie = this.getTrie(brokerId);
    if (!store || !trie) return null;

    const unique = [...new Set((filters || []).map(String))];
    const results = [];
    for (const filter of unique) {
      const r = trie.resolve(filter, { sampleLimit, rootsLimit });
      results.push({
        ...r,
        sample: r.sample.map(({ topic, slot }) => ({
          topic,
          ts: store.ts[slot],
          retain: (store.flags[slot] & 1) === 1,
          msgCount: store.count[slot]
        }))
      });
    }
    return {
      topicTotal: store.topicCount(),
      dropped: store.dropped,
      generation: store.n,
      results
    };
  }

  /** One level of the observed topic tree (lazy drill-down for the Flows view). */
  getTopicChildren(brokerId, prefix, { limit = 500 } = {}) {
    const store = this.stores.get(brokerId);
    const trie = this.getTrie(brokerId);
    if (!store || !trie) return null;
    const out = trie.children(prefix, { limit });
    // Hydrate terminal children with liveness info from the store.
    for (const c of out.children) {
      if (c.isTopic) {
        const slot = store.index.get(c.path);
        if (slot !== undefined) {
          c.ts = store.ts[slot];
          c.retain = (store.flags[slot] & 1) === 1;
          c.msgCount = store.count[slot];
        }
      }
    }
    return out;
  }

  // ---- UNS namespace services ----------------------------------------------

  /** UNS conformance lint over the observed namespace (see unsLint.js). */
  lintNamespace(brokerId, opts = {}) {
    const trie = this.getTrie(brokerId);
    if (!trie) return null;
    return lintTrie(trie, opts);
  }

  /**
   * Namespace event feed: new-topic appearances (from the store) merged with
   * Sparkplug BIRTH/DEATH lifecycle events (from the registry), newest first.
   * Both sources are bounded rings, so this is O(events), never O(topics).
   */
  getNamespaceEvents(brokerId, { limit = 200 } = {}) {
    const store = this.stores.get(brokerId);
    if (!store) return null;
    const registry = this.sparkplug.get(brokerId);
    const merged = [...store.events, ...(registry?.events || [])];
    merged.sort((a, b) => b.ts - a.ts);
    return {
      events: merged.slice(0, limit),
      total: merged.length,
      truncated: merged.length > limit
    };
  }

  /**
   * Nested topic-tree summary for the UNS module and MCP (`uns_tree`). Depth-
   * and node-capped so a multimillion-topic broker returns a bounded skeleton:
   * every returned node carries its exact subtreeCount even when its children
   * are cut off, so nothing is silently hidden.
   */
  getUnsTree(brokerId, { depth = 4, maxNodes = 2000, prefix = '' } = {}) {
    const store = this.stores.get(brokerId);
    const trie = this.getTrie(brokerId);
    if (!store || !trie) return null;

    let root = trie.root;
    if (prefix) {
      for (const seg of String(prefix).split('/')) {
        root = root.children?.get(seg);
        if (!root) return { prefix, nodes: [], total: store.topicCount(), truncated: false };
      }
    }

    let used = 0;
    let truncated = false;
    const build = (node, path, name, d) => {
      used++;
      const out = {
        name,
        path,
        count: node.subtreeCount,
        isTopic: node.slot >= 0
      };
      if (node.slot >= 0) {
        out.ts = store.ts[node.slot];
        out.msgCount = store.count[node.slot];
      }
      if (node.children && d < depth) {
        const kids = [];
        for (const [seg, child] of node.children) {
          if (!path && seg.startsWith('$')) continue; // $SYS etc. is broker plumbing, not namespace
          if (used >= maxNodes) { truncated = true; break; }
          kids.push(build(child, path ? `${path}/${seg}` : seg, seg, d + 1));
        }
        if (kids.length) out.children = kids;
      } else if (node.children && node.children.size > 0) {
        truncated = true; // depth-cut: subtreeCount still tells the whole story
      }
      return out;
    };

    const nodes = [];
    for (const [seg, child] of root.children || []) {
      if (!prefix && seg.startsWith('$')) continue;
      if (used >= maxNodes) { truncated = true; break; }
      nodes.push(build(child, prefix ? `${prefix}/${seg}` : seg, seg, 1));
    }
    return { prefix, nodes, total: store.topicCount(), truncated };
  }

  /** Newest message ts anywhere under `path` ('' = whole namespace). O(subtree). */
  branchLastActivity(brokerId, path = '') {
    const store = this.stores.get(brokerId);
    const trie = this.getTrie(brokerId);
    if (!store || !trie) return null;
    let node = trie.root;
    if (path) {
      for (const seg of String(path).split('/')) {
        node = node.children?.get(seg);
        if (!node) return 0; // branch never observed
      }
    }
    let max = 0;
    const stack = [node];
    while (stack.length) {
      const n = stack.pop();
      if (n.slot >= 0 && store.ts[n.slot] > max) max = store.ts[n.slot];
      if (n.children) for (const c of n.children.values()) stack.push(c);
    }
    return max;
  }

  shutdown() {
    clearInterval(this.cleanupTimer);
    clearInterval(this.statsTimer);
    clearInterval(this.batchTimer);
    this.clients.forEach((client) => client.end(true));
    this.clients.clear();
    this.connections.clear();
    this.stores.clear();
    this.topicMeta.clear();
    this.sparkplug.clear();
    this.admin.clear();
    this.tries.clear();
    this.sys.clear();
    this.recent.clear();
    this.rowCache.clear();
  }
}

module.exports = MqttManager;
