const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
const router = express.Router();

// Models: multi-source attribute bindings published as one merged object at a
// UNS path (the contextualization layer).

// GET /api/models
router.get('/', (req, res) => {
  const { profiles, models } = req.app.locals.services;
  res.json({ models: profiles.listIn('models'), status: models.getStatus() });
});

// POST /api/models { id?, name, enabled, target, publishMode, intervalMs?, attributes }
router.post('/', (req, res) => {
  const { profiles, models } = req.app.locals.services;
  const { id, name, enabled, target, publishMode, intervalMs, attributes } = req.body || {};
  if (!target?.brokerId || !target?.topic) return res.status(400).json({ error: 'target.brokerId and target.topic are required' });
  if (!Array.isArray(attributes) || attributes.length === 0) {
    return res.status(400).json({ error: 'attributes[] is required' });
  }
  for (const a of attributes) {
    if (!a.name || !a.source?.brokerId || !a.source?.topic) {
      return res.status(400).json({ error: 'each attribute needs a name and a source { brokerId, topic }' });
    }
    if (a.source.brokerId === target.brokerId && a.source.topic === target.topic) {
      return res.status(400).json({ error: `attribute "${a.name}" sources the model's own output topic (loop)` });
    }
  }
  const saved = profiles.upsertIn('models', id || uuidv4(), {
    name: name || null,
    enabled: enabled !== false,
    target: { brokerId: target.brokerId, topic: target.topic, retain: Boolean(target.retain) },
    publishMode: publishMode === 'interval' ? 'interval' : 'on-change',
    intervalMs: Number(intervalMs) > 0 ? Number(intervalMs) : 5000,
    attributes
  });
  models.syncTimers();
  res.status(201).json(saved);
});

// DELETE /api/models/:id
router.delete('/:id', (req, res) => {
  const { profiles, models } = req.app.locals.services;
  if (!profiles.removeIn('models', req.params.id)) {
    return res.status(404).json({ error: 'Model not found' });
  }
  models.syncTimers();
  res.json({ removed: req.params.id });
});

module.exports = router;
