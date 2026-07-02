const express = require('express');
const router = express.Router();

// GET /api/opcua/connections
router.get('/connections', (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  res.json({ connections: opcuaManager.getConnections() });
});

// POST /api/opcua/connections — connect to an endpoint
router.post('/connections', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  try {
    const result = await opcuaManager.connect(req.body || {});
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/opcua/connections/:connectionId
router.delete('/connections/:connectionId', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  try {
    res.json(await opcuaManager.disconnect(req.params.connectionId));
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
