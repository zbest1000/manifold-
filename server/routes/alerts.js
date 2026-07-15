const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { RULE_TYPES, VALUE_OPS } = require('../services/alertEngine');
const router = express.Router();

// Alert rules are persisted in the profile store; the engine picks changes up
// on its next evaluation pass (no restart, no re-arm dance).

// GET /api/alerts/rules
router.get('/rules', (req, res) => {
  const { profiles, alerts } = req.app.locals.services;
  res.json({
    rules: profiles?.alertRules() || [],
    types: RULE_TYPES,
    // Webhook delivery health — collected by the engine, surfaced here so a
    // silently failing webhook shows up somewhere an operator looks.
    webhookFailures: alerts?.webhookFailures || 0,
    lastWebhookError: alerts?.lastWebhookError || null
  });
});

// POST /api/alerts/rules { name, type, brokerId, path?, topic?, prefix?, thresholdMs?,
//                          field?, op?, value?, sustainMs?, clearValue?, webhookUrl?, enabled? }
router.post('/rules', (req, res) => {
  const { profiles } = req.app.locals.services;
  const { id, name, type, brokerId, path, topic, prefix, thresholdMs, field, op, value, sustainMs, clearValue, webhookUrl, enabled } = req.body || {};
  if (!RULE_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${RULE_TYPES.join(', ')}` });
  }
  if (!brokerId) return res.status(400).json({ error: 'brokerId is required' });
  if (type === 'topic-silent' && !topic) return res.status(400).json({ error: 'topic is required for topic-silent rules' });

  const base = {
    name: name || null,
    type,
    brokerId,
    path: path || '',
    topic: topic || null,
    prefix: prefix || '',
    thresholdMs: Number(thresholdMs) > 0 ? Number(thresholdMs) : 60_000,
    webhookUrl: webhookUrl || null,
    enabled: enabled !== false
  };

  if (type === 'value-threshold') {
    if (!topic) return res.status(400).json({ error: 'topic is required for value-threshold rules' });
    if (!VALUE_OPS.includes(op)) return res.status(400).json({ error: `op must be one of: ${VALUE_OPS.join(', ')}` });
    const limit = Number(value);
    if (!Number.isFinite(limit)) return res.status(400).json({ error: 'value must be a number' });
    const sustain = sustainMs === undefined || sustainMs === null || sustainMs === '' ? 0 : Number(sustainMs);
    if (!Number.isFinite(sustain) || sustain < 0) return res.status(400).json({ error: 'sustainMs must be a number >= 0' });
    let clear = null;
    if (clearValue !== undefined && clearValue !== null && clearValue !== '') {
      clear = Number(clearValue);
      if (!Number.isFinite(clear)) return res.status(400).json({ error: 'clearValue must be a number' });
    }
    Object.assign(base, {
      field: field ? String(field) : null,
      op,
      value: limit,
      sustainMs: sustain,
      clearValue: clear
    });
  }

  const rule = profiles.upsertAlertRule(id || uuidv4(), base);
  res.status(201).json(rule);
});

// DELETE /api/alerts/rules/:id
router.delete('/rules/:id', (req, res) => {
  const { profiles } = req.app.locals.services;
  if (!profiles.removeAlertRule(req.params.id)) {
    return res.status(404).json({ error: 'Rule not found' });
  }
  res.json({ removed: req.params.id });
});

// GET /api/alerts/events?limit=200 — recent firings, newest first
router.get('/events', (req, res) => {
  const { alerts } = req.app.locals.services;
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  res.json({ events: alerts ? alerts.getEvents(limit) : [] });
});

module.exports = router;
