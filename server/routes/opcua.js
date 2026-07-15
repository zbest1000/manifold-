const express = require('express');
const router = express.Router();

// GET /api/opcua/connections
router.get('/connections', (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  res.json({ connections: opcuaManager.getConnections() });
});

// POST /api/opcua/discover { endpointUrl } — connect with security None, list
// the server's endpoints (mode/policy/securityLevel + server certificate),
// disconnect. Bounded to ~10s inside the manager.
router.post('/discover', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  const { endpointUrl } = req.body || {};
  if (!endpointUrl || typeof endpointUrl !== 'string') {
    return res.status(400).json({ error: 'endpointUrl is required (e.g. opc.tcp://host:4840)' });
  }
  try {
    const endpoints = await opcuaManager.discoverEndpoints(endpointUrl);
    res.json({ endpointUrl, endpoints });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/opcua/certificate — the Manifold application certificate (PEM +
// thumbprint/subject/validity), created on first use in <dataDir>/pki.
router.get('/certificate', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  try {
    res.json(await opcuaManager.getApplicationCertificate());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/opcua/trust — trusted + rejected server certificates in the PKI store
router.get('/trust', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  try {
    res.json(await opcuaManager.listTrust());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/opcua/trust { thumbprint } — promote a rejected certificate to trusted
router.post('/trust', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  const { thumbprint } = req.body || {};
  if (!thumbprint || typeof thumbprint !== 'string') {
    return res.status(400).json({ error: 'thumbprint is required (SHA1 hex, see GET /api/opcua/trust)' });
  }
  try {
    const certificate = await opcuaManager.trustCertificate(thumbprint);
    if (!certificate) {
      return res.status(404).json({ error: `no rejected certificate with thumbprint ${thumbprint}` });
    }
    res.json({ status: 'trusted', certificate });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/opcua/connections — connect to an endpoint (profile persisted)
router.post('/connections', async (req, res) => {
  const { opcuaManager, profiles } = req.app.locals.services;
  try {
    const result = await opcuaManager.connect(req.body || {});
    profiles?.upsertOpcua(result.connectionId, { ...(req.body || {}), id: result.connectionId });
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/opcua/connections/:connectionId — update a saved endpoint in place:
// disconnect the existing session, reconnect under the SAME id, persist the new
// config on success (like POST). Validated like POST (endpointUrl is required).
router.put('/connections/:connectionId', async (req, res) => {
  const { opcuaManager, profiles } = req.app.locals.services;
  const connectionId = req.params.connectionId;
  const saved = profiles?.opcuaEndpoints().find((c) => c.id === connectionId);
  if (!opcuaManager.getConnections().some((c) => c.id === connectionId) && !saved) {
    return res.status(404).json({ error: 'OPC UA connection not found' });
  }
  const body = req.body || {};
  // Leave-blank-to-keep: an omitted password keeps the stored one.
  if (body.password === undefined && saved?.password !== undefined) {
    body.password = saved.password;
  }
  try {
    const result = await opcuaManager.updateConnection(connectionId, body);
    profiles?.upsertOpcua(connectionId, { ...body, id: connectionId });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/opcua/connections/:connectionId (profile removed)
router.delete('/connections/:connectionId', async (req, res) => {
  const { opcuaManager, profiles } = req.app.locals.services;
  try {
    const result = await opcuaManager.disconnect(req.params.connectionId);
    profiles?.removeOpcua(req.params.connectionId);
    res.json(result);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

// GET /api/opcua/connections/:connectionId/browse?nodeId=ns=0;i=84
router.get('/connections/:connectionId/browse', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  try {
    const result = await opcuaManager.browse(req.params.connectionId, req.query.nodeId || undefined);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/opcua/connections/:connectionId/read?nodeId=...
router.get('/connections/:connectionId/read', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  if (!req.query.nodeId) return res.status(400).json({ error: 'nodeId query parameter is required' });
  try {
    const result = await opcuaManager.read(req.params.connectionId, req.query.nodeId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/opcua/connections/:connectionId/monitor { nodeId, samplingInterval }
router.post('/connections/:connectionId/monitor', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  const { nodeId, samplingInterval } = req.body || {};
  if (!nodeId) return res.status(400).json({ error: 'nodeId is required' });
  try {
    const result = await opcuaManager.monitor(req.params.connectionId, nodeId, samplingInterval || 500);
    res.status(202).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/opcua/connections/:connectionId/unmonitor { nodeId }
router.post('/connections/:connectionId/unmonitor', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  const { nodeId } = req.body || {};
  if (!nodeId) return res.status(400).json({ error: 'nodeId is required' });
  try {
    res.json(await opcuaManager.unmonitor(req.params.connectionId, nodeId));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
