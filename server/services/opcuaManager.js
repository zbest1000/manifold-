const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const {
  OPCUAClient,
  MessageSecurityMode,
  SecurityPolicy,
  AttributeIds,
  TimestampsToReturn,
  UserTokenType
} = require('node-opcua-client');
// node-opcua-client does not re-export the certificate manager — pull it (and
// the cert parsing helpers) from the packages it is built on.
const { OPCUACertificateManager, makeSubject } = require('node-opcua-certificate-manager');
const { exploreCertificateInfo, makeSHA1Thumbprint, readCertificate } = require('node-opcua-crypto');

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

const APPLICATION_NAME = 'Manifold';
// Must match the URI baked into the application certificate — node-opcua's
// certificate sanity check compares the two on every secure connect.
const APPLICATION_URI = 'urn:manifold:client';
const DISCOVERY_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Application PKI (lazily initialized, shared by every secure connection).
// Rooted at <MANIFOLD_DATA_DIR|server/data>/pki with the standard node-opcua
// layout: own/{certs,private}, trusted/certs, rejected/, issuers/...
// Unknown server certificates are NOT auto-accepted; they land in rejected/
// where the trust API (or a connect with trustServer:true) can promote them.
// ---------------------------------------------------------------------------

let certificateManagerPromise = null;

function pkiRootFolder() {
  return path.join(process.env.MANIFOLD_DATA_DIR || path.join(__dirname, '..', 'data'), 'pki');
}

function clientCertificateFile(certificateManager) {
  // Same default path OPCUAClient derives when given a certificate manager.
  return path.join(certificateManager.rootDir, 'own', 'certs', 'client_certificate.pem');
}

function getCertificateManager() {
  if (!certificateManagerPromise) {
    certificateManagerPromise = (async () => {
      const certificateManager = new OPCUACertificateManager({
        rootFolder: pkiRootFolder(),
        automaticallyAcceptUnknownCertificate: false,
        keySize: 2048 // fast to generate on first use, universally accepted
      });
      await certificateManager.initialize();
      const certificateFile = clientCertificateFile(certificateManager);
      if (!fs.existsSync(certificateFile)) {
        const hostname = os.hostname();
        await certificateManager.createSelfSignedCertificate({
          applicationUri: APPLICATION_URI,
          dns: [hostname],
          outputFile: certificateFile,
          subject: makeSubject(APPLICATION_NAME, hostname),
          startDate: new Date(),
          validity: 365 * 10
        });
      }
      return certificateManager;
    })();
    // A failed init (e.g. unwritable data dir) must not poison every later
    // call — drop the cached promise so the next caller retries.
    certificateManagerPromise.catch(() => {
      certificateManagerPromise = null;
    });
  }
  return certificateManagerPromise;
}

function describeCertificate(der) {
  const cert = { thumbprint: makeSHA1Thumbprint(der).toString('hex') };
  try {
    const info = exploreCertificateInfo(der);
    cert.subject = formatSubject(info.subject);
    cert.validFrom = info.notBefore || null;
    cert.validTo = info.notAfter || null;
  } catch {
    // unparsable cert — the thumbprint is still enough to identify/trust it
  }
  return cert;
}

function formatSubject(subject) {
  if (!subject) return null;
  if (typeof subject === 'string') return subject;
  const parts = Object.entries(subject)
    .filter(([, v]) => typeof v === 'string' && v.length)
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(', ') : null;
}

function readCertificateFolder(folder) {
  let files = [];
  try {
    files = fs.readdirSync(folder);
  } catch {
    return []; // folder not created yet == empty store
  }
  const out = [];
  for (const file of files) {
    if (!/\.(pem|der|crt|cer)$/i.test(file)) continue;
    try {
      out.push({ file, ...describeCertificate(readCertificate(path.join(folder, file))) });
    } catch {
      // skip files that are not certificates
    }
  }
  return out;
}

// Translate node-opcua's security status codes into something actionable.
function withTrustHint(error) {
  const message = error?.message || String(error);
  if (/BadSecurityChecksFailed|BadCertificateUntrusted|certificate\b.*\bnot trusted|untrusted/i.test(message)) {
    return new Error(
      'server certificate not trusted — retry with trustServer or trust it via the certificates API ' +
        `(POST /api/opcua/trust). If the server rejected OUR certificate instead, trust the Manifold ` +
        `client certificate (GET /api/opcua/certificate) on the server. [${message}]`
    );
  }
  return error;
}

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

    const securityMode = MessageSecurityMode[config.securityMode] ?? MessageSecurityMode.None;
    const securityPolicy = SecurityPolicy[config.securityPolicy] ?? SecurityPolicy.None;
    const secure = securityMode !== MessageSecurityMode.None;

    const clientOptions = {
      applicationName: APPLICATION_NAME,
      endpointMustExist: false,
      securityMode,
      securityPolicy,
      connectionStrategy: { maxRetry: 2, initialDelay: 1000, maxDelay: 5000 },
      keepSessionAlive: true
    };

    // Security None keeps the historical fast path (no PKI requirement). Any
    // signed/encrypted mode — or an explicit trustServer — runs through the
    // shared application PKI so the client presents our certificate and
    // verifies the server's against trusted/.
    let certificateManager = null;
    if (secure || config.trustServer === true) {
      certificateManager = await getCertificateManager();
      clientOptions.applicationUri = APPLICATION_URI;
      clientOptions.clientCertificateManager = certificateManager;
      clientOptions.certificateFile = clientCertificateFile(certificateManager);
      clientOptions.privateKeyFile = certificateManager.privateKey;
    }

    const client = OPCUAClient.create(clientOptions);

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

    // trustServer: node-opcua's accept-unknown flag lives on the certificate
    // manager (shared across connections), not on the connect call — so we
    // toggle it for the duration of this connect and restore it in `finally`.
    // The window is small; a concurrent secure connect during it would also
    // be auto-accepted, which is an acceptable trade-off for this tool.
    const toggleAutoAccept = certificateManager !== null && config.trustServer === true;
    const previousAutoAccept = toggleAutoAccept
      ? certificateManager.automaticallyAcceptUnknownCertificate
      : null;
    if (toggleAutoAccept) certificateManager.automaticallyAcceptUnknownCertificate = true;

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
    } catch (rawError) {
      const error = withTrustHint(rawError);
      info.status = 'error';
      info.lastError = error.message;
      this.io.emit('opcua-error', { connectionId, error: error.message });
      this.connections.delete(connectionId);
      await client.disconnect().catch(() => {});
      throw error;
    } finally {
      if (toggleAutoAccept) certificateManager.automaticallyAcceptUnknownCertificate = previousAutoAccept;
    }
  }

  /**
   * Connect with security None, list the server's endpoints, disconnect.
   * Bounded by DISCOVERY_TIMEOUT_MS (opc.tcp — the HTTP timeout helper does
   * not apply here) so a black-holed host can't pin the request forever.
   */
  async discoverEndpoints(endpointUrl, timeoutMs = DISCOVERY_TIMEOUT_MS) {
    if (!endpointUrl) {
      throw new Error('endpointUrl is required (e.g. opc.tcp://host:4840)');
    }
    const client = OPCUAClient.create({
      applicationName: APPLICATION_NAME,
      endpointMustExist: false,
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None,
      connectionStrategy: { maxRetry: 0, initialDelay: 500, maxDelay: 1000 }
    });

    let timer = null;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`endpoint discovery timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      timer.unref?.();
    });

    try {
      const endpoints = await Promise.race([
        (async () => {
          await client.connect(endpointUrl);
          return client.getEndpoints();
        })(),
        deadline
      ]);
      return (endpoints || [])
        .map((endpoint) => {
          const policyUri = endpoint.securityPolicyUri || '';
          return {
            endpointUrl: endpoint.endpointUrl || null,
            securityMode: MessageSecurityMode[endpoint.securityMode] || String(endpoint.securityMode),
            securityPolicy: policyUri.includes('#') ? policyUri.split('#').pop() : policyUri,
            securityLevel: endpoint.securityLevel ?? 0,
            serverCertificate:
              endpoint.serverCertificate && endpoint.serverCertificate.length
                ? describeCertificate(endpoint.serverCertificate)
                : null
          };
        })
        .sort((a, b) => b.securityLevel - a.securityLevel);
    } finally {
      if (timer) clearTimeout(timer);
      client.disconnect().catch(() => {});
    }
  }

  /** The application certificate (PEM + parsed details), creating it if needed. */
  async getApplicationCertificate() {
    const certificateManager = await getCertificateManager();
    const certificateFile = clientCertificateFile(certificateManager);
    return {
      applicationUri: APPLICATION_URI,
      pkiFolder: certificateManager.rootDir,
      pem: fs.readFileSync(certificateFile, 'utf8'),
      ...describeCertificate(readCertificate(certificateFile))
    };
  }

  /** Trusted + rejected server certificates currently in the PKI store. */
  async listTrust() {
    const certificateManager = await getCertificateManager();
    return {
      trusted: readCertificateFolder(certificateManager.trustedFolder),
      rejected: readCertificateFolder(certificateManager.rejectedFolder)
    };
  }

  /**
   * Promote a rejected server certificate (by SHA1 thumbprint) to trusted.
   * Returns the certificate description, or null if no rejected certificate
   * matches the thumbprint.
   */
  async trustCertificate(thumbprint) {
    const certificateManager = await getCertificateManager();
    const wanted = String(thumbprint).toLowerCase();
    let files = [];
    try {
      files = fs.readdirSync(certificateManager.rejectedFolder);
    } catch {
      return null;
    }
    for (const file of files) {
      if (!/\.(pem|der|crt|cer)$/i.test(file)) continue;
      const filePath = path.join(certificateManager.rejectedFolder, file);
      let der;
      try {
        der = readCertificate(filePath);
      } catch {
        continue;
      }
      if (makeSHA1Thumbprint(der).toString('hex').toLowerCase() !== wanted) continue;
      await certificateManager.trustCertificate(der); // moves rejected/ -> trusted/certs
      // If the manager's index knew the cert under a different (canonical)
      // filename, our on-disk copy survives the move — drop it so the same
      // thumbprint never shows up as both trusted and rejected.
      fs.rmSync(filePath, { force: true });
      return describeCertificate(der);
    }
    return null;
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

  /**
   * Update a saved endpoint in place: validate first (a bad body must not kill
   * a live session), close the existing session if any, then connect again
   * under the SAME id. disconnect() sets `closing` on the OLD entry only —
   * connect() builds a fresh entry, so the update never ends up stuck in a
   * terminal state. Like a POST-created connection, it starts with no monitors.
   */
  async updateConnection(connectionId, config = {}) {
    if (!config.endpointUrl) {
      throw new Error('endpointUrl is required (e.g. opc.tcp://host:4840)');
    }
    if (this.connections.has(connectionId)) {
      await this.disconnect(connectionId);
    }
    return this.connect({ ...config, id: connectionId });
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
