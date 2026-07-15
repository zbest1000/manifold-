const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const {
  OPCUAClient,
  MessageSecurityMode,
  SecurityPolicy,
  AttributeIds,
  TimestampsToReturn,
  UserTokenType
} = require('node-opcua-client');

const NODE_CLASS_NAMES = {
  0: 'Unspecified',
  1: 'Object',
  2: 'Variable',
  4: 'Method',
  8: 'ObjectType',
  16: 'VariableType',
  32: 'ReferenceType',
  64: 'DataType',
  128: 'View'
};

const ROOT_NODE_ID = 'ns=0;i=84';

function toPlainValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return { type: 'buffer', base64: value.toString('base64') };
  if (Array.isArray(value)) return value.map(toPlainValue);
  if (typeof value === 'object') {
    if (typeof value.toJSON === 'function') return value.toJSON();
    return JSON.parse(JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  }
  return value;
}

class OpcuaManager extends EventEmitter {
  constructor(io) {
    super();
    this.io = io;
    this.connections = new Map(); // connectionId -> { client, session, subscription, info, monitored }
  }

  async connect(config = {}) {
    if (!config.endpointUrl) {
      throw new Error('endpointUrl is required (e.g. opc.tcp://host:4840)');
    }

    const connectionId = config.id || uuidv4();
    if (this.connections.has(connectionId)) {
      throw new Error(`OPC UA connection ${connectionId} already exists`);
    }

    const client = OPCUAClient.create({
      applicationName: 'Manifold',
      endpointMustExist: false,
      securityMode: MessageSecurityMode[config.securityMode] ?? MessageSecurityMode.None,
      securityPolicy: SecurityPolicy[config.securityPolicy] ?? SecurityPolicy.None,
      connectionStrategy: { maxRetry: 2, initialDelay: 1000, maxDelay: 5000 },
      keepSessionAlive: true
    });

    const info = {
      id: connectionId,
      name: config.name || config.endpointUrl,
      endpointUrl: config.endpointUrl,
      securityMode: config.securityMode || 'None',
      securityPolicy: config.securityPolicy || 'None',
      username: config.username || null,
      status: 'connecting',
      connectedAt: null,
      lastError: null,
      monitoredCount: 0
    };

    const entry = {
      client,
      session: null,
      subscription: null,
      info,
      monitored: new Map(),
      // nodeId -> samplingInterval, so monitors can be rebuilt after reconnect
      monitorSpecs: new Map(),
      closing: false
    };
    this.connections.set(connectionId, entry);
    this.io.emit('opcua-connection-attempt', { connectionId, connection: { ...info } });

    client.on('connection_lost', () => {
      info.status = 'reconnecting';
      this.io.emit('opcua-reconnecting', { connectionId });
    });
    client.on('connection_reestablished', () => {
      info.status = 'connected';
      this.io.emit('opcua-connected', { connectionId, connection: { ...info } });
      // The transport is back, but the subscription/monitored items may not
      // have survived — rebuild them from the recorded specs so monitoredCount
      // never lies after a reconnect.
      this._recoverMonitors(connectionId).catch((error) => {
        info.lastError = `re-monitor after reconnect: ${error.message}`;
        this.io.emit('opcua-error', { connectionId, error: info.lastError });
      });
    });
    client.on('close', () => {
      // Fires when the client gives up for good (or on user disconnect).
      // Without this, a dead endpoint shows "reconnecting" forever.
      if (!entry.closing && info.status !== 'disconnected') {
        info.status = 'disconnected';
        info.lastError = info.lastError || 'connection closed';
        this.io.emit('opcua-disconnected', { connectionId });
      }
    });

    try {
      await client.connect(config.endpointUrl);

      const userIdentity = config.username
        ? { type: UserTokenType.UserName, userName: config.username, password: config.password || '' }
        : { type: UserTokenType.Anonymous };
      entry.session = await client.createSession(userIdentity);

      info.status = 'connected';
      info.connectedAt = new Date();
      this.io.emit('opcua-connected', { connectionId, connection: { ...info } });
      return { connectionId, status: 'connected', endpointUrl: config.endpointUrl };
    } catch (error) {
      info.status = 'error';
      info.lastError = error.message;
      this.io.emit('opcua-error', { connectionId, error: error.message });
      this.connections.delete(connectionId);
      await client.disconnect().catch(() => {});
      throw error;
    }
  }

  requireSession(connectionId) {
    const entry = this.connections.get(connectionId);
    if (!entry || !entry.session) {
      throw new Error(`OPC UA connection ${connectionId} is not established`);
    }
    return entry;
  }

  async browse(connectionId, nodeId = ROOT_NODE_ID) {
    const entry = this.requireSession(connectionId);
    const result = await entry.session.browse(nodeId);

    const references = (result.references || []).map((ref) => ({
      nodeId: ref.nodeId.toString(),
      browseName: ref.browseName.toString(),
      displayName: ref.displayName?.text || ref.browseName.name,
      nodeClass: NODE_CLASS_NAMES[ref.nodeClass] || String(ref.nodeClass),
      typeDefinition: ref.typeDefinition?.toString() || null,
      isForward: ref.isForward
    }));

    return { nodeId, references };
  }

  async read(connectionId, nodeId) {
    const entry = this.requireSession(connectionId);
    const attributes = [
      ['displayName', AttributeIds.DisplayName],
      ['browseName', AttributeIds.BrowseName],
      ['nodeClass', AttributeIds.NodeClass],
      ['description', AttributeIds.Description],
      ['dataType', AttributeIds.DataType],
      ['value', AttributeIds.Value],
      ['accessLevel', AttributeIds.AccessLevel]
    ];

    const results = await entry.session.read(
      attributes.map(([, attributeId]) => ({ nodeId, attributeId }))
    );

    const out = { nodeId };
    attributes.forEach(([key], i) => {
      const dv = results[i];
      if (!dv.statusCode.isGood()) return;
      let value = dv.value?.value;
      if (key === 'nodeClass') value = NODE_CLASS_NAMES[value] || value;
      else if (key === 'displayName' || key === 'description') value = value?.text ?? null;
      else if (key === 'browseName') value = value?.toString() ?? null;
      else if (key === 'dataType') value = value?.toString() ?? null;
      else value = toPlainValue(value);
      out[key] = value;
    });

    const valueDv = results[5];
    out.valueStatus = valueDv.statusCode.toString();
    out.sourceTimestamp = valueDv.sourceTimestamp || null;
    return out;
  }

  async monitor(connectionId, nodeId, samplingInterval = 500) {
    const entry = this.requireSession(connectionId);
    if (entry.monitored.has(nodeId)) {
      return { connectionId, nodeId, status: 'already-monitored' };
    }

    if (!entry.subscription) {
      entry.subscription = await entry.session.createSubscription2({
        requestedPublishingInterval: 250,
        requestedLifetimeCount: 1000,
        requestedMaxKeepAliveCount: 20,
        maxNotificationsPerPublish: 100,
        publishingEnabled: true,
        priority: 10
      });
    }

    const item = await entry.subscription.monitor(
      { nodeId, attributeId: AttributeIds.Value },
      { samplingInterval, discardOldest: true, queueSize: 10 },
      TimestampsToReturn.Both
    );

    item.on('changed', (dataValue) => {
      const evt = {
        connectionId,
        nodeId,
        value: toPlainValue(dataValue.value?.value),
        dataType: dataValue.value?.dataType !== undefined ? String(dataValue.value.dataType) : null,
        status: dataValue.statusCode.toString(),
        sourceTimestamp: dataValue.sourceTimestamp || null,
        serverTimestamp: dataValue.serverTimestamp || null
      };
      this.io.emit('opcua-value', evt);
      // In-process tap for the tag binding engine (socket clients aside).
      this.emit('value', evt);
    });

    entry.monitored.set(nodeId, item);
    entry.monitorSpecs.set(nodeId, samplingInterval);
    entry.info.monitoredCount = entry.monitored.size;
    this.io.emit('opcua-monitor-started', { connectionId, nodeId, samplingInterval });
    return { connectionId, nodeId, status: 'monitoring', samplingInterval };
  }

  /**
   * Rebuild the subscription and every monitored item after a reconnect.
   * Deterministic over clever: the old subscription is torn down even if it
   * survived (a redundant re-subscribe is cheap; a silently dead monitor is
   * not) and each recorded (nodeId, interval) is re-monitored.
   */
  async _recoverMonitors(connectionId) {
    const entry = this.connections.get(connectionId);
    if (!entry || entry.monitorSpecs.size === 0) return;
    const specs = [...entry.monitorSpecs.entries()];
    if (entry.subscription) {
      await entry.subscription.terminate().catch(() => {});
      entry.subscription = null;
    }
    entry.monitored.clear();
    entry.monitorSpecs.clear();
    entry.info.monitoredCount = 0;
    for (const [nodeId, interval] of specs) {
      await this.monitor(connectionId, nodeId, interval).catch((error) => {
        entry.info.lastError = `re-monitor ${nodeId}: ${error.message}`;
      });
    }
  }

  async unmonitor(connectionId, nodeId) {
    const entry = this.requireSession(connectionId);
    const item = entry.monitored.get(nodeId);
    if (item) {
      await item.terminate();
      entry.monitored.delete(nodeId);
      entry.monitorSpecs.delete(nodeId);
      entry.info.monitoredCount = entry.monitored.size;
    }
    this.io.emit('opcua-monitor-stopped', { connectionId, nodeId });
    return { connectionId, nodeId, status: 'stopped' };
  }

  async disconnect(connectionId) {
    const entry = this.connections.get(connectionId);
    if (!entry) {
      throw new Error(`Unknown OPC UA connection ${connectionId}`);
    }
    entry.closing = true; // suppress the 'close' handler's disconnected event

    try {
      for (const item of entry.monitored.values()) {
        await item.terminate().catch(() => {});
      }
      if (entry.subscription) await entry.subscription.terminate().catch(() => {});
      if (entry.session) await entry.session.close().catch(() => {});
      await entry.client.disconnect();
    } finally {
      this.connections.delete(connectionId);
      this.io.emit('opcua-disconnected', { connectionId });
    }
    return { connectionId, status: 'disconnected' };
  }

  getConnections() {
    return Array.from(this.connections.values()).map((entry) => ({
      ...entry.info,
      monitoredNodes: Array.from(entry.monitored.keys())
    }));
  }

  async shutdown() {
    for (const connectionId of Array.from(this.connections.keys())) {
      await this.disconnect(connectionId).catch(() => {});
    }
  }
}

module.exports = OpcuaManager;
