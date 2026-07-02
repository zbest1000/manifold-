const express = require('express');
const router = express.Router();

// GET /api/i3x/status
router.get('/status', (req, res) => {
  const { i3x } = req.app.locals.services;
  res.json(i3x.status());
});

// POST /api/i3x/connect { baseUrl, token? } — verify + store the server
router.post('/connect', async (req, res) => {
  const { i3x } = req.app.locals.services;
  try {
    res.json(await i3x.connect(req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/i3x/probe { baseUrl } — check if a URL is an i3X server (no state change)
router.post('/probe', async (req, res) => {
  const { i3x } = req.app.locals.services;
  const { baseUrl } = req.body || {};
  if (!baseUrl) return res.status(400).json({ error: 'baseUrl is required' });
  const info = await i3x.probe(baseUrl);
  res.json({ baseUrl, isI3x: Boolean(info), info });
});

// DELETE /api/i3x/connect
router.delete('/connect', (req, res) => {
  const { i3x } = req.app.locals.services;
  res.json(i3x.reset());
});

// GET /api/i3x/namespaces
router.get('/namespaces', async (req, res) => {
  const { i3x } = req.app.locals.services;
  try {
    res.json({ namespaces: await i3x.listNamespaces() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/i3x/objecttypes?namespaceUri=
router.get('/objecttypes', async (req, res) => {
  const { i3x } = req.app.locals.services;
  try {
    res.json({ objectTypes: await i3x.listObjectTypes(req.query.namespaceUri) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/i3x/objects?typeElementId=&root=&includeMetadata=
router.get('/objects', async (req, res) => {
  const { i3x } = req.app.locals.services;
  try {
    const objects = await i3x.listObjects({
      typeElementId: req.query.typeElementId,
      root: req.query.root,
      includeMetadata: req.query.includeMetadata === 'true'
    });
    res.json({ objects });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/i3x/graph?typeElementId=&root= — objects assembled into a node graph
router.get('/graph', async (req, res) => {
  const { i3x } = req.app.locals.services;
  try {
    const objects = await i3x.listObjects({
      typeElementId: req.query.typeElementId,
      root: req.query.root
    });
    res.json({ graph: i3x.buildGraph(objects), objectCount: objects.length });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/i3x/related { elementIds, relationshipType? }
router.post('/related', async (req, res) => {
  const { i3x } = req.app.locals.services;
  const { elementIds, relationshipType } = req.body || {};
  try {
    res.json({ results: await i3x.getRelated(elementIds, relationshipType) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/i3x/value { elementIds, maxDepth? }
router.post('/value', async (req, res) => {
  const { i3x } = req.app.locals.services;
  const { elementIds, maxDepth } = req.body || {};
  try {
    res.json({ results: await i3x.getValues(elementIds, maxDepth ?? 1) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/i3x/history { elementIds, startTime, endTime, maxDepth? }
router.post('/history', async (req, res) => {
  const { i3x } = req.app.locals.services;
  const { elementIds, startTime, endTime, maxDepth } = req.body || {};
  try {
    res.json({ results: await i3x.getHistory(elementIds, startTime, endTime, maxDepth ?? 1) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
