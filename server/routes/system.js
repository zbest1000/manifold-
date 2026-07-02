const express = require('express');
const router = express.Router();

// GET /api/system/status
router.get('/status', (req, res) => {
  const { mqttManager, opcuaManager, discovery } = req.app.locals.services;
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    mqtt: {
      connections: mqttManager.getConnections().length,
      brokers: mqttManager.getConnections().map((c) => ({ id: c.id, name: c.name, status: c.status }))
    },
    opcua: {
      connections: opcuaManager.getConnections().length,
      endpoints: opcuaManager.getConnections().map((c) => ({ id: c.id, name: c.name, status: c.status }))
    },
    discovery: {
      scanning: discovery.isScanning()
    }
  });
});

// POST /api/system/discovery/start { range, mqttPorts, opcuaPorts }
router.post('/discovery/start', async (req, res) => {
  const { discovery } = req.app.locals.services;
  try {
    const result = await discovery.startScan(req.body || {});
    res.status(202).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/system/discovery/stop
router.post('/discovery/stop', (req, res) => {
  const { discovery } = req.app.locals.services;
  res.json(discovery.stopScan());
});

// GET /api/system/discovery/results
router.get('/discovery/results', (req, res) => {
  const { discovery } = req.app.locals.services;
  res.json({ scanning: discovery.isScanning(), results: discovery.getLastResults() });
});

module.exports = router;
