const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

// Recordings (time-series capture) + replay control.

// GET /api/recorder — recordings with live status
router.get('/', (req, res) => {
  const { profiles, recorder, replayer } = req.app.locals.services;
  res.json({
    recordings: profiles.listIn('recordings').map((r) => ({ ...r, status: recorder.getStatus(r.id) })),
    replay: replayer.getStatus()
  });
});

// Replay control — registered before the /:id routes so "replay" is never
// captured as a recording id.
// POST /api/recorder/replay { recordingId, brokerId, speed?, loop?, topicPrefix? }
router.post('/replay', async (req, res) => {
  const { replayer } = req.app.locals.services;
  try {
    res.status(202).json(await replayer.start(req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/recorder/replay — stop the active replay
router.delete('/replay', (req, res) => {
  const { replayer } = req.app.locals.services;
  res.json({ stopped: replayer.stop() });
});

// POST /api/recorder { id?, name, brokerId, filter, target?, maxBytes?, enabled? }
router.post('/', (req, res) => {
  const { profiles } = req.app.locals.services;
  const { id, name, brokerId, filter, target, maxBytes, enabled } = req.body || {};
  if (!brokerId || !filter) return res.status(400).json({ error: 'brokerId and filter are required' });
  if (target && target.type === 'historian' && !target.historianId) {
    return res.status(400).json({ error: 'target.historianId is required for historian targets' });
  }
  const saved = profiles.upsertIn('recordings', id || uuidv4(), {
    name: name || null,
    brokerId,
    filter,
    target: target?.type === 'historian' ? { type: 'historian', historianId: target.historianId } : { type: 'file' },
    maxBytes: Number(maxBytes) > 0 ? Number(maxBytes) : undefined,
    enabled: enabled !== false
  });
  res.status(201).json(saved);
});

// DELETE /api/recorder/:id — remove config AND its data file
router.delete('/:id', (req, res) => {
  const { profiles, recorder } = req.app.locals.services;
  if (!profiles.removeIn('recordings', req.params.id)) {
    return res.status(404).json({ error: 'Recording not found' });
  }
  recorder.remove(req.params.id);
  res.json({ removed: req.params.id });
});

// GET /api/recorder/:id/data?topic=&from=&to=&limit= — bounded read-back
router.get('/:id/data', async (req, res) => {
  const { profiles, recorder } = req.app.locals.services;
  if (!profiles.getIn('recordings', req.params.id)) {
    return res.status(404).json({ error: 'Recording not found' });
  }
  res.json(
    await recorder.read(req.params.id, {
      topic: req.query.topic || null,
      from: Number(req.query.from) || 0,
      to: Number(req.query.to) || Infinity,
      limit: Number(req.query.limit) || 500
    })
  );
});

module.exports = router;
