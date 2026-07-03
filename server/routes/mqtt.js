const express = require('express');
const router = express.Router();

// GET /api/mqtt/brokers — list connections
router.get('/brokers', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  res.json({ brokers: mqttManager.getConnections() });
});

// POST /api/mqtt/brokers — connect to a broker
router.post('/brokers', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  try {
    const result = mqttManager.connectToBroker(req.body || {});
    res.status(202).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/mqtt/brokers/:brokerId
router.get('/brokers/:brokerId', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  const connection = mqttManager.getConnection(req.params.brokerId);
  if (!connection) return res.status(404).json({ error: 'Broker not found' });
  res.json({
    broker: connection,
    subscriptions: mqttManager.getSubscriptions(req.params.brokerId)
  });
});

// DELETE /api/mqtt/brokers/:brokerId — disconnect
router.delete('/brokers/:brokerId', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  try {
    res.json(mqttManager.disconnectFromBroker(req.params.brokerId));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

// GET /api/mqtt/brokers/:brokerId/topics?limit=100000
// Bounded so a broker with millions of topics can't produce an unbounded
// response; the live stream keeps filling the client's index beyond the limit.
router.get('/brokers/:brokerId/topics', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  if (!mqttManager.getConnection(req.params.brokerId)) {
    return res.status(404).json({ error: 'Broker not found' });
  }
  const limit = Math.min(Number(req.query.limit) || 100000, 500000);
  const { topics, total, dropped } = mqttManager.getTopics(req.params.brokerId, { limit });
  res.json({ topics, total, dropped, truncated: total > topics.length });
});

// GET /api/mqtt/brokers/:brokerId/messages?topic=...&limit=50
router.get('/brokers/:brokerId/messages', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  const { topic, limit } = req.query;
  if (!topic) return res.status(400).json({ error: 'topic query parameter is required' });
  if (!mqttManager.getConnection(req.params.brokerId)) {
    return res.status(404).json({ error: 'Broker not found' });
  }
  const messages = mqttManager.getMessages(
    req.params.brokerId,
    topic,
    Math.min(Number(limit) || 50, 500)
  );
  res.json({ topic, count: messages.length, messages });
});

// POST /api/mqtt/brokers/:brokerId/subscribe { topic, qos }
router.post('/brokers/:brokerId/subscribe', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  const { topic, qos } = req.body || {};
  if (!topic) return res.status(400).json({ error: 'topic is required' });
  try {
    mqttManager.subscribe(req.params.brokerId, topic, qos || 0);
    res.status(202).json({ brokerId: req.params.brokerId, topic, qos: qos || 0 });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/mqtt/brokers/:brokerId/unsubscribe { topic }
router.post('/brokers/:brokerId/unsubscribe', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  const { topic } = req.body || {};
  if (!topic) return res.status(400).json({ error: 'topic is required' });
  try {
    mqttManager.unsubscribe(req.params.brokerId, topic);
    res.status(202).json({ brokerId: req.params.brokerId, topic });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/mqtt/brokers/:brokerId/publish { topic, payload, qos, retain }
router.post('/brokers/:brokerId/publish', async (req, res) => {
  const { mqttManager } = req.app.locals.services;
  const { topic, payload, qos, retain } = req.body || {};
  if (!topic) return res.status(400).json({ error: 'topic is required' });
  try {
    const result = await mqttManager.publish(req.params.brokerId, topic, payload ?? '', { qos, retain });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
