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

// ---- Authentication -------------------------------------------------------
// This is a CONTROL PLANE, not a viewer: the API can publish to brokers
// (including Sparkplug commands that actuate equipment), disconnect
// connections, and start network scans. Set TC_AUTH_TOKEN to require a bearer
// token on every /api route and on the Socket.IO handshake. Without it the
// server runs open (dev convenience) and says so loudly at startup.
const AUTH_TOKEN = process.env.TC_AUTH_TOKEN || '';

function tokenMatches(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(AUTH_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.use('/api', (req, res, next) => {
  if (!AUTH_TOKEN) return next();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (tokenMatches(token)) return next();
  res.status(401).json({ error: 'Unauthorized: missing or invalid bearer token' });
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
const pipelines = new PipelineEngine({ mqttManager, profiles });
const recorder = new Recorder({ mqttManager, profiles });
const replayer = new Replayer({ mqttManager, recorder });
const contracts = new SchemaContracts({ mqttManager, profiles, io });
const models = new ModelEngine({ mqttManager, profiles });

app.locals.services = {
  mqttManager, opcuaManager, discovery, cesmii, i3x, profiles, history, alerts,
  pipelines, recorder, replayer, contracts, models
};

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
pipelines.start();
recorder.start();
contracts.start();
models.start();

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

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    mqttConnections: mqttManager.getConnections().length,
    opcuaConnections: opcuaManager.getConnections().length
  });
});

io.use((socket, next) => {
  if (!AUTH_TOKEN) return next();
  if (tokenMatches(socket.handshake.auth?.token)) return next();
  next(new Error('Unauthorized'));
});

io.on('connection', (socket) => {
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
  history.snapshot(); // final flush before rings are torn down
  history.stop();
  alerts.stop();
  await pipelines.flushHistorians().catch(() => {});
  pipelines.stop();
  await recorder.flushHistorians().catch(() => {});
  recorder.stop();
  replayer.stop();
  contracts.stop();
  models.stop();
  mqttManager.shutdown();
  await opcuaManager.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server, io };
