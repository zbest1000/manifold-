const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

// Pipeline routes: source → transforms → target, persisted in profiles and
// executed by the PipelineEngine on the live (coalesced) message stream.

const TRANSFORM_TYPES = ['repath', 'pick', 'rename', 'set', 'scale', 'numeric', 'sparkplugFlatten', 'envelope'];

function validateRoute(body) {
  if (!body.source?.brokerId || !body.source?.filter) return 'source.brokerId and source.filter are required';
  const target = body.target || {};
  if (target.type === 'mqtt') {
    if (!target.brokerId) return 'target.brokerId is required for mqtt targets';
  } else if (target.type === 'historian') {
    if (!target.historianId) return 'target.historianId is required for historian targets';
  } else {
    return 'target.type must be "mqtt" or "historian"';
  }
  for (const t of body.transforms || []) {
    if (!TRANSFORM_TYPES.includes(t.type)) return `unknown transform type "${t.type}" (supported: ${TRANSFORM_TYPES.join(', ')})`;
  }
  return null;
}

// GET /api/pipelines — routes + live metrics + store-and-forward outbox health
router.get('/', (req, res) => {
  const { profiles, pipelines, outbox } = req.app.locals.services;
  res.json({
    routes: profiles.listIn('pipelines'),
    metrics: pipelines.getMetrics(),
    outbox: outbox ? outbox.getStats() : {},
    transformTypes: TRANSFORM_TYPES
  });
});

// POST /api/pipelines { id?, name, enabled, source, transforms, target }
router.post('/', (req, res) => {
  const { profiles } = req.app.locals.services;
  const body = req.body || {};
  const problem = validateRoute(body);
  if (problem) return res.status(400).json({ error: problem });
  const saved = profiles.upsertIn('pipelines', body.id || uuidv4(), {
    name: body.name || null,
    enabled: body.enabled !== false,
    source: { brokerId: body.source.brokerId, filter: body.source.filter },
    transforms: body.transforms || [],
    target: body.target
  });
  res.status(201).json(saved);
});

// DELETE /api/pipelines/:id
router.delete('/:id', (req, res) => {
  const { profiles } = req.app.locals.services;
  if (!profiles.removeIn('pipelines', req.params.id)) {
    return res.status(404).json({ error: 'Route not found' });
  }
  res.json({ removed: req.params.id });
});

// POST /api/pipelines/preview { route, sampleLimit? } — dry-run an (unsaved)
// route definition against observed topics; nothing is published.
router.post('/preview', (req, res) => {
  const { pipelines } = req.app.locals.services;
  const { route, sampleLimit } = req.body || {};
  if (!route) return res.status(400).json({ error: 'route is required' });
  const problem = validateRoute(route);
  if (problem) return res.status(400).json({ error: problem });
  res.json(pipelines.preview(route, { sampleLimit: Math.min(Number(sampleLimit) || 25, 200) }));
});

module.exports = router;
