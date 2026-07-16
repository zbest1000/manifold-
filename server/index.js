const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
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
const { AuditLog, redact } = require('./services/auditLog');
const metricsExporter = require('./services/metricsExporter');
const SparkplugPublisher = require('./services/sparkplugPublisher');
const { TagBindings } = require('./services/tagBindings');

const mqttRoutes = require('./routes/mqtt');
const opcuaRoutes = require('./routes/opcua');
const systemRoutes = require('./routes/system');
const cesmiiRoutes = require('./routes/cesmii');
const i3xRoutes = require('./routes/i3x');
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

// CORS: in production the client is served same-origin, so no cross-origin
// grants are needed at all; in dev the Vite server's origin gets access.
// A blanket cors() would let any website script an authenticated browser.
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3000' }));

// Security headers. contentSecurityPolicy is disabled by default because the
// Vite dev client and the built SPA differ; the served bundle is same-origin and
// self-contained. crossOriginResourcePolicy is relaxed so the dev client on a
// different port can still load assets.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  })
);

app.use(express.json({ limit: '10mb' }));

// General request rate limit — a coarse backstop against resource abuse (scan
// spam, wildcard-resolution floods) that the auth-failure bucket does not cover.
// Applies to the whole API; /metrics and /health stay unlimited for scrapers.
const apiLimiter = rateLimit({
  windowMs: Number(process.env.MANIFOLD_RATE_WINDOW_MS) || 60_000,
  max: Number(process.env.MANIFOLD_RATE_MAX) || 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down' }
});

// ---- Authentication + roles -------------------------------------------------
// This is a CONTROL PLANE, not a viewer: the API can publish to brokers
// (including Sparkplug commands that actuate equipment), disconnect
// connections, and start network scans. Set MANIFOLD_AUTH_TOKEN to require a bearer
// token on every /api route and on the Socket.IO handshake. MANIFOLD_VIEWER_TOKEN
// (optional) grants a READ-ONLY role: GETs succeed, every mutation is 403.
// For teams, MANIFOLD_TOKENS holds NAMED tokens ("alice:s3cret:admin,grafana:tok:viewer")
// so each credential is individually revocable and audit entries carry who
// acted. Without any token the server runs open (dev convenience) and says so
// loudly at startup.
const AUTH_TOKEN = process.env.MANIFOLD_AUTH_TOKEN || '';
const VIEWER_TOKEN = process.env.MANIFOLD_VIEWER_TOKEN || '';
const NAMED_TOKENS = (process.env.MANIFOLD_TOKENS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [name, token, role] = s.split(':');
    return name && token ? { name, token, role: role === 'viewer' ? 'viewer' : 'admin' } : null;
  })
  .filter(Boolean);
const AUTH_ENABLED = Boolean(AUTH_TOKEN || NAMED_TOKENS.length);

function timingEqual(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length === 0 || !expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** → { role, tokenName } or null. tokenName feeds the audit trail. */
function identityForToken(token) {
  if (!AUTH_ENABLED) return { role: 'admin', tokenName: 'open' };
  if (AUTH_TOKEN && timingEqual(token, AUTH_TOKEN)) return { role: 'admin', tokenName: 'admin' };
  if (VIEWER_TOKEN && timingEqual(token, VIEWER_TOKEN)) return { role: 'viewer', tokenName: 'viewer' };
  for (const t of NAMED_TOKENS) {
    if (timingEqual(token, t.token)) return { role: t.role, tokenName: t.name };
  }
  return null;
}

function roleForToken(token) {
  return identityForToken(token)?.role || null;
}

// Brute-force guard: a per-IP token bucket on FAILED auth attempts. Successful
// requests are never throttled — this only slows credential guessing.
const authFailures = new Map(); // ip -> { count, resetAt }
const AUTH_FAIL_LIMIT = 20;
const AUTH_FAIL_WINDOW_MS = 60_000;
function authFailureExceeded(ip) {
  const now = Date.now();
  let e = authFailures.get(ip);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + AUTH_FAIL_WINDOW_MS };
    authFailures.set(ip, e);
    if (authFailures.size > 10_000) authFailures.clear(); // bounded, coarse
  }
  e.count++;
  return e.count > AUTH_FAIL_LIMIT;
}

// Shared auth check used by BOTH the REST middleware and the Socket.IO
// handshake so the brute-force throttle and failure accounting can never drift
// between the two entry points (they used to — the socket path had neither).
// Returns { identity } on success or { throttled } / {} on failure.
function checkAuth(token, ip) {
  const identity = identityForToken(token);
  if (identity) return { identity };
  const throttled = authFailureExceeded(ip);
  return { throttled };
}

app.use('/api', apiLimiter, (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const { identity, throttled } = checkAuth(token, req.ip);
  if (!identity) {
    if (throttled) {
      return res.status(429).json({ error: 'Too many failed authentication attempts — wait a minute' });
    }
    return res.status(401).json({ error: 'Unauthorized: missing or invalid bearer token' });
  }
  if (identity.role === 'viewer' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return res.status(403).json({ error: 'Forbidden: viewer token is read-only' });
  }
  req.role = identity.role;
  req.tokenName = identity.tokenName;
  next();
});

// Serve the built SPA whenever it exists on disk — not gated on NODE_ENV, which
// nothing outside Docker sets, so `npm run build && npm start` used to yield a
// blank "Cannot GET /". A built client/dist is the signal, not an env var.
const clientDist = path.join(__dirname, '../client/dist');
const serveClient = fs.existsSync(path.join(clientDist, 'index.html'));
if (serveClient) {
  app.use(express.static(clientDist));
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
if (process.env.MANIFOLD_NO_RESTORE !== '1') {
  // History BEFORE broker reconnect: restore only refills empty rings, so a
  // fast-publishing broker that connects first would wipe out the snapshot.
  const restoredMsgs = history.restore();
  if (restoredMsgs) console.log(`history: restored ${restoredMsgs} recent message(s)`);
  restoreProfiles();
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
app.use('/api/uns', unsRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/historians', historianRoutes);
app.use('/api/pipelines', pipelineRoutes);
app.use('/api/recorder', recorderRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/models', modelRoutes);
app.use('/api/tags', tagRoutes);

// GET /api/whoami — lets the client discover whether auth is on and what role
// the caller holds, so the UI can render a read-only badge and disable mutation
// controls for viewers instead of letting every click 403.
app.get('/api/whoami', (req, res) => {
  res.json({
    authEnabled: AUTH_ENABLED,
    role: req.role,
    ...(req.tokenName && req.tokenName !== 'open' ? { tokenName: req.tokenName } : {})
  });
});

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
  const ip = socket.handshake.address;
  const { identity, throttled } = checkAuth(socket.handshake.auth?.token, ip);
  if (!identity) {
    // Same throttle + audit trail as the REST path, so websocket handshakes
    // can't be used to sidestep the brute-force limiter or evade logging.
    audit.record({ role: 'none', ip, method: 'SOCKET', path: 'handshake', outcome: throttled ? 'throttled' : 'unauthorized' });
    return next(new Error(throttled ? 'Too many failed authentication attempts' : 'Unauthorized'));
  }
  socket.data.role = identity.role;
  socket.data.tokenName = identity.tokenName;
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
    // Full-fidelity audit: include a redacted copy of the event args (brokerId,
    // topic, ...) so a socket-path publish is as traceable as its REST twin.
    let summary;
    try {
      summary = packet[1] && typeof packet[1] === 'object' ? JSON.stringify(redact(packet[1])).slice(0, 400) : undefined;
    } catch {
      summary = '[unserializable]';
    }
    audit.record({
      role: socket.data.role || 'open',
      ...(socket.data.tokenName && socket.data.tokenName !== 'open' ? { tokenName: socket.data.tokenName } : {}),
      ip: socket.handshake.address,
      method: 'SOCKET',
      path: packet[0],
      ...(summary ? { body: summary } : {})
    });
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

if (serveClient) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const PORT = process.env.PORT || 5000;
// Fail closed: with no auth token configured the control plane binds loopback
// only, so an accidentally-open instance is reachable solely from its own host.
// Exposing an unauthenticated instance beyond localhost is now a deliberate act:
// set MANIFOLD_HOST=0.0.0.0 explicitly (and you'll be warned). With auth on, the
// default is all interfaces as before.
const HOST = process.env.MANIFOLD_HOST || (AUTH_ENABLED ? '0.0.0.0' : '127.0.0.1');
server.listen(PORT, HOST, () => {
  console.log(`Manifold server listening on ${HOST}:${PORT}`);
  if (!AUTH_ENABLED) {
    if (HOST === '127.0.0.1' || HOST === 'localhost') {
      console.warn(
        '⚠️  MANIFOLD_AUTH_TOKEN is not set — bound to localhost only. ' +
          'Set MANIFOLD_AUTH_TOKEN to require a token, or MANIFOLD_HOST=0.0.0.0 to expose ' +
          'this UNAUTHENTICATED instance to the network (anyone who can reach it can publish ' +
          'to brokers and start scans).'
      );
    } else {
      console.warn(
        `🚨  MANIFOLD_AUTH_TOKEN is not set but the server is bound to ${HOST} — the API and ` +
          'socket are UNAUTHENTICATED and reachable off-host. Anyone who can reach this port ' +
          'can publish to brokers and start network scans. Set MANIFOLD_AUTH_TOKEN NOW.'
      );
    }
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
