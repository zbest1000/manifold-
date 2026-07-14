const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

// UNS mounts: external sources (OPC UA connections, the i3X namespace) grafted
// into the Unified Namespace view. A mount is pure configuration — the client
// resolves it against the live connection when rendering — so it persists in
// the profile store and survives restarts.
//
//   { id, type: 'opcua'|'i3x', connectionId?, label?, nodeId? }

// GET /api/uns/mounts
router.get('/mounts', (req, res) => {
  const { profiles } = req.app.locals.services;
  res.json({ mounts: profiles?.mounts() || [] });
});

// POST /api/uns/mounts { type, connectionId?, label?, nodeId? }
router.post('/mounts', (req, res) => {
  const { profiles } = req.app.locals.services;
  const { type, connectionId, label, nodeId } = req.body || {};
  if (!['opcua', 'i3x'].includes(type)) {
    return res.status(400).json({ error: 'type must be "opcua" or "i3x"' });
  }
  if (type === 'opcua' && !connectionId) {
    return res.status(400).json({ error: 'connectionId is required for opcua mounts' });
  }
  const mount = profiles.upsertMount(uuidv4(), {
    type,
    connectionId: connectionId || null,
    label: label || null,
    nodeId: nodeId || null
  });
  res.status(201).json(mount);
});

// DELETE /api/uns/mounts/:id
router.delete('/mounts/:id', (req, res) => {
  const { profiles } = req.app.locals.services;
  if (!profiles.removeMount(req.params.id)) {
    return res.status(404).json({ error: 'Mount not found' });
  }
  res.json({ removed: req.params.id });
});

module.exports = router;
