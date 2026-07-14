const express = require('express');
const { v4: uuidv4 } = require('uuid');
const historians = require('../services/historians');
const router = express.Router();

// Historian connections (InfluxDB v2, Timebase). Secrets are stored
// server-side and never echoed back (publicConfig redacts).

// GET /api/historians
router.get('/', (req, res) => {
  const { profiles } = req.app.locals.services;
  res.json({
    historians: profiles.listIn('historians').map(historians.publicConfig),
    types: historians.supportedTypes()
  });
});

// POST /api/historians { id?, name, type, url, ...backend fields }
router.post('/', (req, res) => {
  const { profiles } = req.app.locals.services;
  const {
    id, name, type, url, org, bucket, token, measurement, dataset, stream, messageType, writePath,
    apiKey, apiSecret, host, port, database, user, password, ssl, table
  } = req.body || {};
  if (!historians.supportedTypes().includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${historians.supportedTypes().join(', ')}` });
  }
  if (type === 'timescaledb') {
    if (!host || !database || !user) return res.status(400).json({ error: 'host, database, and user are required for timescaledb' });
  } else if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }
  if (type === 'influxdb' && (!org || !bucket)) return res.status(400).json({ error: 'org and bucket are required for influxdb' });
  if (type === 'timebase' && !dataset) return res.status(400).json({ error: 'dataset is required for timebase' });
  if (type === 'timebase-ce' && !stream) return res.status(400).json({ error: 'stream is required for timebase-ce' });

  const existing = id ? profiles.getIn('historians', id) : null;
  const saved = profiles.upsertIn('historians', id || uuidv4(), {
    name: name || null,
    type,
    url: url || null,
    org: org || null,
    bucket: bucket || null,
    measurement: measurement || null,
    dataset: dataset || null,
    stream: stream || null,
    messageType: messageType || null,
    writePath: writePath || null,
    host: host || null,
    port: Number(port) || null,
    database: database || null,
    user: user || null,
    ssl: Boolean(ssl),
    table: table || null,
    // keep the stored secret when the client omits it on edit
    token: token !== undefined ? token : existing?.token || null,
    apiKey: apiKey !== undefined ? apiKey : existing?.apiKey || null,
    apiSecret: apiSecret !== undefined ? apiSecret : existing?.apiSecret || null,
    password: password !== undefined ? password : existing?.password || null
  });
  res.status(201).json(historians.publicConfig(saved));
});

// DELETE /api/historians/:id
router.delete('/:id', (req, res) => {
  const { profiles } = req.app.locals.services;
  if (!profiles.removeIn('historians', req.params.id)) {
    return res.status(404).json({ error: 'Historian not found' });
  }
  res.json({ removed: req.params.id });
});

// POST /api/historians/:id/test — write one test point, report the outcome
router.post('/:id/test', async (req, res) => {
  const { profiles } = req.app.locals.services;
  const conn = profiles.getIn('historians', req.params.id);
  if (!conn) return res.status(404).json({ error: 'Historian not found' });
  try {
    const result = await historians.writePoints(conn, [
      { tag: 'manifold/connection-test', ts: Date.now(), value: 1 }
    ]);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

module.exports = router;
