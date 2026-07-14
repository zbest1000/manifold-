'use strict';

const { monitorEventLoopDelay } = require('perf_hooks');

/**
 * Prometheus exposition for Manifold itself — the tool that watches your
 * namespace should be watchable. Hand-rolled text format (no dependency):
 * process health, event-loop delay, per-broker ingest counters, pipeline
 * route metrics, historian outbox depth (store-and-forward health), recorder,
 * contracts, alerts, and tag bindings.
 */

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

function esc(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function line(name, labels, value) {
  if (!Number.isFinite(value)) return '';
  const l = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : '';
  return `${name}${l} ${value}\n`;
}

function render(services) {
  const { mqttManager, pipelines, outbox, recorder, contracts, alerts, bindings, profiles } = services;
  let out = '';
  const gauge = (n, help) => (out += `# HELP ${n} ${help}\n# TYPE ${n} gauge\n`);
  const counter = (n, help) => (out += `# HELP ${n} ${help}\n# TYPE ${n} counter\n`);

  gauge('manifold_process_uptime_seconds', 'Process uptime');
  out += line('manifold_process_uptime_seconds', null, process.uptime());
  gauge('manifold_process_memory_bytes', 'Process memory');
  const mem = process.memoryUsage();
  out += line('manifold_process_memory_bytes', { kind: 'rss' }, mem.rss);
  out += line('manifold_process_memory_bytes', { kind: 'heap_used' }, mem.heapUsed);
  gauge('manifold_event_loop_delay_ms', 'Event loop delay percentiles');
  out += line('manifold_event_loop_delay_ms', { quantile: '0.5' }, loopDelay.percentile(50) / 1e6);
  out += line('manifold_event_loop_delay_ms', { quantile: '0.99' }, loopDelay.percentile(99) / 1e6);

  counter('manifold_broker_messages_received_total', 'Messages received per broker');
  gauge('manifold_broker_topics', 'Distinct topics per broker');
  for (const info of mqttManager?.getConnections() || []) {
    out += line('manifold_broker_messages_received_total', { broker: info.name || info.id }, info.metrics.messagesReceived);
    out += line('manifold_broker_topics', { broker: info.name || info.id }, info.metrics.topicCount);
  }

  counter('manifold_pipeline_messages_total', 'Pipeline route counters');
  const routeNames = new Map((profiles?.listIn('pipelines') || []).map((r) => [r.id, r.name || r.id.slice(0, 8)]));
  for (const [routeId, m] of Object.entries(pipelines?.getMetrics() || {})) {
    const route = routeNames.get(routeId) || routeId.slice(0, 8);
    out += line('manifold_pipeline_messages_total', { route, result: 'matched' }, m.matched);
    out += line('manifold_pipeline_messages_total', { route, result: 'delivered' }, m.published);
    out += line('manifold_pipeline_messages_total', { route, result: 'error' }, m.errors);
    out += line('manifold_pipeline_messages_total', { route, result: 'loop_blocked' }, m.loopBlocked);
  }

  gauge('manifold_outbox_queued_points', 'Historian outbox in-memory queue depth');
  gauge('manifold_outbox_spill_bytes', 'Historian outbox on-disk spill size');
  counter('manifold_outbox_points_total', 'Historian outbox point outcomes');
  for (const [id, s] of Object.entries(outbox?.getStats() || {})) {
    const historian = id.slice(0, 8);
    out += line('manifold_outbox_queued_points', { historian }, s.queued);
    out += line('manifold_outbox_spill_bytes', { historian }, s.spillBytes);
    out += line('manifold_outbox_points_total', { historian, result: 'written' }, s.written);
    out += line('manifold_outbox_points_total', { historian, result: 'spilled' }, s.spilled);
    out += line('manifold_outbox_points_total', { historian, result: 'dropped' }, s.dropped);
  }

  counter('manifold_recorder_points_total', 'Recorder captured points');
  for (const rec of profiles?.listIn('recordings') || []) {
    out += line('manifold_recorder_points_total', { recording: rec.name || rec.id.slice(0, 8) }, recorder?.getStatus(rec.id).points ?? 0);
  }

  counter('manifold_contract_checks_total', 'Contract validations');
  counter('manifold_contract_violations_total', 'Contract violations');
  for (const [id, c] of Object.entries(contracts?.getCounters() || {})) {
    out += line('manifold_contract_checks_total', { contract: id.slice(0, 8) }, c.checked);
    out += line('manifold_contract_violations_total', { contract: id.slice(0, 8) }, c.violations);
  }

  gauge('manifold_alert_events', 'Alert events in the history ring');
  out += line('manifold_alert_events', null, alerts?.history?.length ?? 0);

  counter('manifold_binding_published_total', 'Tag binding publishes');
  for (const [id, s] of Object.entries(bindings?.getStatus() || {})) {
    out += line('manifold_binding_published_total', { binding: id.slice(0, 8) }, s.published);
  }

  return out;
}

module.exports = { render };
