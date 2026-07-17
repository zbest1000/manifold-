const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
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
    id, name, type, url, org, bucket, token, measurement, dataset, writePath,
    apiKey, host, port, database, user, password, ssl, sslInsecure, sslRootCert, table, dropPolicy
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

  const existing = id ? profiles.getIn('historians', id) : null;
  const saved = profiles.upsertIn('historians', id || uuidv4(), {
    name: name || null,
    type,
    url: url || null,
    org: org || null,
    bucket: bucket || null,
    measurement: measurement || null,
    dataset: dataset || null,
    writePath: writePath || null,
    host: host || null,
    port: Number(port) || null,
    database: database || null,
    user: user || null,
    ssl: Boolean(ssl),
    sslInsecure: Boolean(sslInsecure),
    sslRootCert: sslRootCert || null,
    table: table || null,
    dropPolicy: dropPolicy === 'oldest' ? 'oldest' : 'newest',
    // keep the stored secret when the client omits it on edit
    token: token !== undefined ? token : existing?.token || null,
    apiKey: apiKey !== undefined ? apiKey : existing?.apiKey || null,
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

// ---- read-back (Trends page) -------------------------------------------------

const parseTs = (v) => (typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v)));

// GET /api/historians/:id/tags?search=&limit= — distinct stored topic names
router.get('/:id/tags', async (req, res) => {
  const { profiles } = req.app.locals.services;
  const conn = profiles.getIn('historians', req.params.id);
  if (!conn) return res.status(404).json({ error: 'Historian not found' });
  const search = String(req.query.search || '');
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 100));
  try {
    const tags = await historians.queryTags(conn, { search, limit });
    res.json({ tags });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

// POST /api/historians/:id/query { tags, start, end, maxPoints } — downsampled series
router.post('/:id/query', async (req, res) => {
  const { profiles } = req.app.locals.services;
  const conn = profiles.getIn('historians', req.params.id);
  if (!conn) return res.status(404).json({ error: 'Historian not found' });
  const { tags, start, end, maxPoints } = req.body || {};
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > 10 || tags.some((t) => typeof t !== 'string' || !t.trim())) {
    return res.status(400).json({ error: 'tags must be an array of 1-10 non-empty strings' });
  }
  const s = parseTs(start);
  const e = parseTs(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) {
    return res.status(400).json({ error: 'start and end must be ISO timestamps or epoch milliseconds' });
  }
  if (e <= s) return res.status(400).json({ error: 'end must be after start' });
  const mp = maxPoints === undefined ? 1000 : Number(maxPoints);
  if (!Number.isFinite(mp) || mp < 10 || mp > 5000) {
    return res.status(400).json({ error: 'maxPoints must be between 10 and 5000' });
  }
  try {
    res.json(await historians.querySeries(conn, { tags, start: s, end: e, maxPoints: Math.round(mp) }));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

module.exports = router;
