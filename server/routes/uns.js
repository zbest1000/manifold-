const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
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

// Custom UNS icons: user-defined single-path SVGs the client's icon picker
// offers alongside the bundled Lucide subset. Pure data (a path `d` string on
// a 24x24 viewBox) — validated strictly so nothing script- or URL-shaped can
// be stored and later inlined into an SVG.
//
//   { id, name (unique, kebab-case), svgPath }

const ICON_NAME_RE = /^[a-z0-9-]{1,40}$/;
// SVG path data only: commands, numbers, separators. No <, >, (, ), quotes,
// or anything else that could smuggle markup/scripts/urls into the SVG.
const ICON_PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9\s,.+-]+$/;
const ICON_PATH_MAX = 4000;

// GET /api/uns/icons
router.get('/icons', (req, res) => {
  const { profiles } = req.app.locals.services;
  res.json({ icons: profiles?.listIn('icons') || [] });
});

// POST /api/uns/icons { name, svgPath } — upserts by name
router.post('/icons', (req, res) => {
  const { profiles } = req.app.locals.services;
  const { name, svgPath } = req.body || {};
  if (typeof name !== 'string' || !ICON_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'name must be 1-40 chars of lowercase letters, digits, or hyphens' });
  }
  if (typeof svgPath !== 'string' || !svgPath.trim() || svgPath.length > ICON_PATH_MAX || !ICON_PATH_RE.test(svgPath)) {
    return res.status(400).json({ error: `svgPath must be SVG path data (M/L/C/... commands and numbers) up to ${ICON_PATH_MAX} chars` });
  }
  const existing = profiles.listIn('icons').find((i) => i.name === name);
  const icon = profiles.upsertIn('icons', existing?.id || uuidv4(), { name, svgPath: svgPath.trim() });
  res.status(existing ? 200 : 201).json(icon);
});

// DELETE /api/uns/icons/:id
router.delete('/icons/:id', (req, res) => {
  const { profiles } = req.app.locals.services;
  if (!profiles.removeIn('icons', req.params.id)) {
    return res.status(404).json({ error: 'Icon not found' });
  }
  res.json({ removed: req.params.id });
});

module.exports = router;
