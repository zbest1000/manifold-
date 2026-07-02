const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const MqttManager = require('./services/mqttManager');
const OpcuaManager = require('./services/opcuaManager');
const DiscoveryService = require('./services/discovery');
const CesmiiClient = require('./services/cesmiiClient');
const I3xClient = require('./services/i3xClient');

const mqttRoutes = require('./routes/mqtt');
const opcuaRoutes = require('./routes/opcua');
const systemRoutes = require('./routes/system');
const cesmiiRoutes = require('./routes/cesmii');
const i3xRoutes = require('./routes/i3x');

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

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
}

const mqttManager = new MqttManager(io);
const opcuaManager = new OpcuaManager(io);
const i3x = new I3xClient();
const discovery = new DiscoveryService(io, { i3x });
const cesmii = new CesmiiClient();

app.locals.services = { mqttManager, opcuaManager, discovery, cesmii, i3x };

app.use('/api/mqtt', mqttRoutes);
app.use('/api/opcua', opcuaRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/cesmii', cesmiiRoutes);
app.use('/api/i3x', i3xRoutes);

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    mqttConnections: mqttManager.getConnections().length,
    opcuaConnections: opcuaManager.getConnections().length
  });
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
  console.log(`Topic Canvas server listening on port ${PORT}`);
});

const shutdown = async () => {
  mqttManager.shutdown();
  await opcuaManager.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server, io };
