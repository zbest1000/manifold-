const express = require('express');
const router = express.Router();

// GET /api/system/status
router.get('/status', (req, res) => {
  const { mqttManager, opcuaManager, discovery, cesmii, i3x } = req.app.locals.services;
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
    },
    cesmii: cesmii.status(),
    i3x: i3x.status()
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

// ---- config as code -----------------------------------------------------------
// Export/import the DataOps configuration (routes, models, historians,
// recordings, contracts, bindings, mounts, alert rules) as one JSON document —
// reviewable in git, promotable between environments. Secrets are STRIPPED on
// export (a config file in a repo must never carry credentials); re-enter them
// after import.

const EXPORT_COLLECTIONS = ['historians', 'pipelines', 'models', 'recordings', 'contracts', 'bindings'];
const SECRET_FIELDS = ['token', 'apiKey', 'apiSecret', 'password', 'secret'];

// GET /api/system/config/export
router.get('/config/export', (req, res) => {
  const { profiles } = req.app.locals.services;
  const out = { manifoldConfig: 1, exportedAt: new Date().toISOString() };
  for (const c of EXPORT_COLLECTIONS) {
    out[c] = profiles.listIn(c).map((item) => {
      const copy = { ...item };
      for (const f of SECRET_FIELDS) if (f in copy) copy[f] = null;
      return copy;
    });
  }
  out.mounts = profiles.mounts();
  out.alertRules = profiles.alertRules().map((r) => ({ ...r, webhookUrl: r.webhookUrl || null }));
  res.setHeader('Content-Disposition', 'attachment; filename="manifold-config.json"');
  res.json(out);
});

// POST /api/system/config/import — merge by id (existing ids are overwritten,
// everything else is left alone; nothing is deleted)
router.post('/config/import', (req, res) => {
  const { profiles } = req.app.locals.services;
  const body = req.body || {};
  if (body.manifoldConfig !== 1) {
    return res.status(400).json({ error: 'not a Manifold config export (missing manifoldConfig: 1)' });
  }
  const imported = {};
  for (const c of EXPORT_COLLECTIONS) {
    if (!Array.isArray(body[c])) continue;
    let n = 0;
    for (const item of body[c]) {
      if (!item || !item.id) continue;
      // keep an existing stored secret if the import carries none
      const existing = profiles.getIn(c, item.id);
      const merged = { ...item };
      for (const f of SECRET_FIELDS) {
        if ((merged[f] === null || merged[f] === undefined) && existing?.[f]) merged[f] = existing[f];
      }
      profiles.upsertIn(c, item.id, merged);
      n++;
    }
    imported[c] = n;
  }
  if (Array.isArray(body.mounts)) {
    for (const m of body.mounts) if (m?.id) profiles.upsertMount(m.id, m);
    imported.mounts = body.mounts.length;
  }
  if (Array.isArray(body.alertRules)) {
    for (const r of body.alertRules) if (r?.id) profiles.upsertAlertRule(r.id, r);
    imported.alertRules = body.alertRules.length;
  }
  res.json({ imported });
});

module.exports = router;

