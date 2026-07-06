const express = require('express');
const router = express.Router();

// GET /api/cesmii/status
router.get('/status', (req, res) => {
  const { cesmii } = req.app.locals.services;
  res.json(cesmii.status());
});

// POST /api/cesmii/config — configure and validate the SMIP connection (persisted)
router.post('/config', async (req, res) => {
  const { cesmii, profiles } = req.app.locals.services;
  try {
    cesmii.configure(req.body || {});
    // Eagerly authenticate so the caller learns immediately if credentials are wrong
    await cesmii.authenticate();
    profiles?.setCesmii(req.body || {});
    res.json(cesmii.status());
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/cesmii/config — clear stored configuration
router.delete('/config', (req, res) => {
  const { cesmii, profiles } = req.app.locals.services;
  profiles?.clearCesmii();
  res.json(cesmii.reset());
});

// GET /api/cesmii/equipment
router.get('/equipment', async (req, res) => {
  const { cesmii } = req.app.locals.services;
  try {
    res.json({ equipment: await cesmii.listEquipment() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/cesmii/places
router.get('/places', async (req, res) => {
  const { cesmii } = req.app.locals.services;
  try {
    res.json({ places: await cesmii.listPlaces() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/cesmii/attributes
router.get('/attributes', async (req, res) => {
  const { cesmii } = req.app.locals.services;
  try {
    res.json({ attributes: await cesmii.listAttributes() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/cesmii/history { ids, startTime, endTime, maxSamples }
router.post('/history', async (req, res) => {
  const { cesmii } = req.app.locals.services;
  const { ids, startTime, endTime, maxSamples } = req.body || {};
  try {
    const samples = await cesmii.getHistory(ids, startTime, endTime, maxSamples ?? 100);
    res.json({ count: samples.length, samples });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/cesmii/query { query, variables } — raw GraphQL passthrough
router.post('/query', async (req, res) => {
  const { cesmii } = req.app.locals.services;
  const { query, variables } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query is required' });
  try {
    res.json({ data: await cesmii.query(query, variables || {}) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
