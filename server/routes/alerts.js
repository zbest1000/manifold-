const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { RULE_TYPES } = require('../services/alertEngine');
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

// POST /api/alerts/rules { name, type, brokerId, path?, topic?, prefix?, thresholdMs?, webhookUrl?, enabled? }
router.post('/rules', (req, res) => {
  const { profiles } = req.app.locals.services;
  const { id, name, type, brokerId, path, topic, prefix, thresholdMs, webhookUrl, enabled } = req.body || {};
  if (!RULE_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${RULE_TYPES.join(', ')}` });
  }
  if (!brokerId) return res.status(400).json({ error: 'brokerId is required' });
  if (type === 'topic-silent' && !topic) return res.status(400).json({ error: 'topic is required for topic-silent rules' });
  const rule = profiles.upsertAlertRule(id || uuidv4(), {
    name: name || null,
    type,
    brokerId,
    path: path || '',
    topic: topic || null,
    prefix: prefix || '',
    thresholdMs: Number(thresholdMs) > 0 ? Number(thresholdMs) : 60_000,
    webhookUrl: webhookUrl || null,
    enabled: enabled !== false
  });
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
