const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const MqttManager = require('./services/mqttManager');
const OpcuaManager = require('./services/opcuaManager');
const DiscoveryService = require('./services/discovery');
const CesmiiClient = require('./services/cesmiiClient');
const I3xClient = require('./services/i3xClient');
const ProfileStore = require('./services/profileStore');
const HistoryStore = require('./services/historyStore');
const { AlertEngine } = require('./services/alertEngine');
const { PipelineEngine } = require('./services/pipelineEngine');
const Recorder = require('./services/recorder');
const Replayer = require('./services/replayer');
const { SchemaContracts } = require('./services/schemaContracts');
const ModelEngine = require('./services/modelEngine');
const HistorianOutbox = require('./services/historianOutbox');
const { AuditLog } = require('./services/auditLog');
const metricsExporter = require('./services/metricsExporter');
const SparkplugPublisher = require('./services/sparkplugPublisher');
const { TagBindings } = require('./services/tagBindings');

const mqttRoutes = require('./routes/mqtt');
const opcuaRoutes = require('./routes/opcua');
const systemRoutes = require('./routes/system');
const cesmiiRoutes = require('./routes/cesmii');
const i3xRoutes = require('./routes/i3x');
const layoutRoutes = require('./routes/layout');
const unsRoutes = require('./routes/uns');
const alertRoutes = require('./routes/alerts');
const historianRoutes = require('./routes/historians');
const pipelineRoutes = require('./routes/pipelines');
const recorderRoutes = require('./routes/recorder');
const contractRoutes = require('./routes/contracts');
const modelRoutes = require('./routes/models');
const tagRoutes = require('./routes/tags');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---- Authentication + roles -------------------------------------------------
// This is a CONTROL PLANE, not a viewer: the API can publish to brokers
// (including Sparkplug commands that actuate equipment), disconnect
// connections, and start network scans. Set TC_AUTH_TOKEN to require a bearer
// token on every /api route and on the Socket.IO handshake. TC_VIEWER_TOKEN
// (optional) grants a READ-ONLY role: GETs succeed, every mutation is 403 —
// hand it to dashboards and observers instead of the admin token. Without any
// token the server runs open (dev convenience) and says so loudly at startup.
const AUTH_TOKEN = process.env.TC_AUTH_TOKEN || '';
const VIEWER_TOKEN = process.env.TC_VIEWER_TOKEN || '';

function timingEqual(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length === 0 || !expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function roleForToken(token) {
  if (!AUTH_TOKEN) return 'admin'; // open mode
  if (timingEqual(token, AUTH_TOKEN)) return 'admin';
  if (VIEWER_TOKEN && timingEqual(token, VIEWER_TOKEN)) return 'viewer';
  return null;
}

app.use('/api', (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const role = roleForToken(token);
  if (!role) return res.status(401).json({ error: 'Unauthorized: missing or invalid bearer token' });
  if (role === 'viewer' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return res.status(403).json({ error: 'Forbidden: viewer token is read-only' });
  }
  req.role = role;
  next();
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
}

const mqttManager = new MqttManager(io);
const opcuaManager = new OpcuaManager(io);
const i3x = new I3xClient();
const discovery = new DiscoveryService(io, { i3x });
const cesmii = new CesmiiClient();
const profiles = new ProfileStore();
const history = new HistoryStore(mqttManager);
const alerts = new AlertEngine({ io, profiles, mqttManager });
const outbox = new HistorianOutbox({ profiles });
const pipelines = new PipelineEngine({ mqttManager, profiles, outbox });
const recorder = new Recorder({ mqttManager, profiles, outbox });
const replayer = new Replayer({ mqttManager, recorder });
const contracts = new SchemaContracts({ mqttManager, profiles, io });
const models = new ModelEngine({ mqttManager, profiles });
const audit = new AuditLog();
const sparkplugPublisher = new SparkplugPublisher({ profiles });
const bindings = new TagBindings({ mqttManager, opcuaManager, profiles, sparkplugPublisher });

app.locals.services = {
  mqttManager, opcuaManager, discovery, cesmii, i3x, profiles, history, alerts,
  pipelines, recorder, replayer, contracts, models,
  outbox, audit, sparkplugPublisher, bindings
};

// Every mutating API call lands in the audit trail (role, ip, route, outcome).
app.use('/api', audit.middleware());

// Restore saved connection profiles so a server restart doesn't lose state.
// Every restore is individually try/caught: an unreachable broker must not stop
// the rest from coming back.
function restoreProfiles() {
  for (const entry of profiles.brokers()) {
    try {
      mqttManager.connectToBroker(entry.config);
      if (entry.admin) mqttManager.setBrokerAdmin(entry.config.id, entry.admin);
    } catch (error) {
      console.warn(`restore: mqtt broker ${entry.config?.host}:${entry.config?.port}: ${error.message}`);
    }
  }
  for (const config of profiles.opcuaEndpoints()) {
    opcuaManager.connect(config).catch((error) => {
      console.warn(`restore: opcua ${config.endpointUrl}: ${error.message}`);
    });
  }
  if (profiles.data.cesmii) {
    try {
      cesmii.configure(profiles.data.cesmii);
    } catch (error) {
      console.warn(`restore: cesmii: ${error.message}`);
    }
  }
  if (profiles.data.i3x) {
    i3x.connect(profiles.data.i3x).catch((error) => {
      console.warn(`restore: i3x ${profiles.data.i3x?.baseUrl}: ${error.message}`);
    });
  }
}
if (process.env.TC_NO_RESTORE !== '1') {
  restoreProfiles();
  const restoredMsgs = history.restore();
  if (restoredMsgs) console.log(`history: restored ${restoredMsgs} recent message(s)`);
}
history.start();
alerts.start();
outbox.start();
pipelines.start();
recorder.start();
contracts.start();
models.start();
bindings.start();

// Engine metrics stream over the socket the client already holds — the UI
// shouldn't have to poll REST for numbers we can push.
const engineMetricsTimer = setInterval(() => {
  if (io.engine.clientsCount === 0) return;
  io.emit('engine-metrics', {
    pipelines: pipelines.getMetrics(),
    outbox: outbox.getStats(),
    bindings: bindings.getStatus(),
    sparkplug: sparkplugPublisher.getStatus(),
    contracts: contracts.getCounters()
  });
}, 2000);
engineMetricsTimer.unref?.();

app.use('/api/mqtt', mqttRoutes);
app.use('/api/opcua', opcuaRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/cesmii', cesmiiRoutes);
app.use('/api/i3x', i3xRoutes);
app.use('/api/layout', layoutRoutes);
app.use('/api/uns', unsRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/historians', historianRoutes);
app.use('/api/pipelines', pipelineRoutes);
app.use('/api/recorder', recorderRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/models', modelRoutes);
app.use('/api/tags', tagRoutes);

// GET /api/audit — recent mutating actions, newest first (admin only)
app.get('/api/audit', (req, res) => {
  if (req.role === 'viewer') return res.status(403).json({ error: 'Forbidden' });
  res.json({ events: audit.recent(Math.min(Number(req.query.limit) || 200, 500)) });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    mqttConnections: mqttManager.getConnections().length,
    opcuaConnections: opcuaManager.getConnections().length
  });
});

// GET /metrics — Prometheus exposition for Manifold itself. Counters only, no
// topic names or payloads, so like /health it stays open for scrapers.
app.get('/metrics', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(metricsExporter.render(app.locals.services));
});

io.use((socket, next) => {
  const role = roleForToken(socket.handshake.auth?.token);
  if (!role) return next(new Error('Unauthorized'));
  socket.data.role = role;
  next();
});

// Socket events that change state — read-only sockets can't fire them, and
// the ones that can are audited like their REST equivalents.
const MUTATING_EVENTS = new Set([
  'connect-mqtt', 'disconnect-mqtt', 'subscribe-topic', 'unsubscribe-topic',
  'publish-message', 'start-discovery', 'stop-discovery', 'opcua-monitor', 'opcua-unmonitor'
]);

io.on('connection', (socket) => {
  socket.use((packet, next) => {
    if (!MUTATING_EVENTS.has(packet[0])) return next();
    if (socket.data.role === 'viewer') {
      socket.emit('error-message', { error: `viewer token is read-only ("${packet[0]}" denied)` });
      return; // drop the packet
    }
    audit.record({ role: socket.data.role || 'open', ip: socket.handshake.address, method: 'SOCKET', path: packet[0] });
    next();
  });

  // Push current state so late-joining clients hydrate immediately
  socket.emit('state-snapshot', {
    mqtt: mqttManager.getConnections(),
    opcua: opcuaManager.getConnections(),
    discovery: { scanning: discovery.isScanning(), results: discovery.getLastResults() }
  });

  socket.on('connect-mqtt', (config, ack) => {
    try {
      const result = mqttManager.connectToBroker(config || {});
      if (typeof ack === 'function') ack({ ok: true, ...result });
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error.message });
      socket.emit('mqtt-error', { error: error.message });
    }
  });

  socket.on('disconnect-mqtt', (brokerId) => {
    try {
      mqttManager.disconnectFromBroker(brokerId);
    } catch {
      // already gone
    }
  });

  socket.on('subscribe-topic', ({ brokerId, topic, qos } = {}) => {
    try {
      mqttManager.subscribe(brokerId, topic, qos || 0);
    } catch (error) {
      socket.emit('subscription-error', { brokerId, topic, error: error.message });
    }
  });

  socket.on('unsubscribe-topic', ({ brokerId, topic } = {}) => {
    try {
      mqttManager.unsubscribe(brokerId, topic);
    } catch (error) {
      socket.emit('unsubscription-error', { brokerId, topic, error: error.message });
    }
  });

  socket.on('publish-message', ({ brokerId, topic, payload, options } = {}) => {
    mqttManager.publish(brokerId, topic, payload, options).catch((error) => {
      socket.emit('publish-error', { brokerId, topic, error: error.message });
    });
  });

  socket.on('start-discovery', (options) => {
    discovery.startScan(options || {}).catch((error) => {
      socket.emit('discovery-error', { error: error.message });
    });
  });

  socket.on('stop-discovery', () => discovery.stopScan());

  socket.on('opcua-monitor', ({ connectionId, nodeId, samplingInterval } = {}) => {
    opcuaManager.monitor(connectionId, nodeId, samplingInterval).catch((error) => {
      socket.emit('opcua-error', { connectionId, nodeId, error: error.message });
    });
  });

  socket.on('opcua-unmonitor', ({ connectionId, nodeId } = {}) => {
    opcuaManager.unmonitor(connectionId, nodeId).catch(() => {});
  });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Manifold server listening on port ${PORT}`);
  if (!AUTH_TOKEN) {
    console.warn(
      '⚠️  TC_AUTH_TOKEN is not set — the API and socket are UNAUTHENTICATED. ' +
        'Anyone who can reach this port can publish to brokers and start scans. ' +
        'Set TC_AUTH_TOKEN before exposing this beyond localhost.'
    );
  }
});

const shutdown = async () => {
  history.snapshot({ sync: true }); // final flush before rings are torn down
  history.stop();
  alerts.stop();
  pipelines.stop();
  recorder.stop();
  await outbox.flush().catch(() => {}); // last chance to deliver; failures spill to disk
  outbox.stop();
  replayer.stop();
  contracts.stop();
  models.stop();
  bindings.stop();
  await sparkplugPublisher.stop().catch(() => {}); // clean NDEATHs, not broker-side wills
  await require('./services/historians').closePools().catch(() => {});
  audit.close();
  mqttManager.shutdown();
  await opcuaManager.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server, io };
