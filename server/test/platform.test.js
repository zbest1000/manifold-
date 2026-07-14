const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { AuditLog, redact } = require('../services/auditLog');
const metricsExporter = require('../services/metricsExporter');
const { encodePayload } = require('../services/sparkplugEncoder');
const SparkplugDecoder = require('../services/sparkplugDecoder');
const { TagBindings, opcQuality, targetTopic } = require('../services/tagBindings');
const MqttManager = require('../services/mqttManager');

function fakeProfiles(data = {}) {
  return {
    listIn: (c) => Object.values(data[c] || {}),
    getIn: (c, id) => (data[c] || {})[id] || null
  };
}

const msg = (brokerId, topic, payload, extra = {}) => ({
  brokerId, topic, payload, qos: 0, retain: false, timestamp: new Date().toISOString(), ...extra
});

// ---- audit log --------------------------------------------------------------------

test('audit log redacts secrets and persists JSONL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-audit-'));
  const audit = new AuditLog(dir);
  audit.record({ role: 'admin', method: 'POST', path: '/api/historians', body: JSON.stringify(redact({ url: 'http://x', token: 'sekrit', nested: { apiSecret: 'shh', ok: 1 } })) });
  const recent = audit.recent();
  assert.strictEqual(recent.length, 1);
  assert.ok(!recent[0].body.includes('sekrit'));
  assert.ok(!recent[0].body.includes('shh'));
  assert.ok(recent[0].body.includes('[redacted]'));
  await audit.close();
  // file exists and holds the line
  const raw = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');
  assert.ok(raw.includes('/api/historians'));
  assert.ok(!raw.includes('sekrit'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- metrics exporter --------------------------------------------------------------

test('metrics exporter renders valid Prometheus text with engine counters', () => {
  const m = new MqttManager({ emit() {} });
  const text = metricsExporter.render({
    mqttManager: m,
    pipelines: { getMetrics: () => ({ r1: { matched: 5, published: 4, errors: 1, loopBlocked: 0 } }) },
    outbox: { getStats: () => ({ h1: { queued: 2, spillBytes: 100, written: 9, spilled: 3, dropped: 0 } }) },
    recorder: { getStatus: () => ({ points: 0 }) },
    contracts: { getCounters: () => ({ c1: { checked: 10, violations: 2 } }) },
    alerts: { history: [1, 2] },
    bindings: { getStatus: () => ({ b1: { published: 7 } }) },
    profiles: fakeProfiles({ pipelines: { r1: { id: 'r1', name: 'norm' } } })
  });
  assert.match(text, /manifold_process_uptime_seconds \d/);
  assert.match(text, /manifold_event_loop_delay_ms\{quantile="0.99"\}/);
  assert.match(text, /manifold_pipeline_messages_total\{route="norm",result="delivered"\} 4/);
  assert.match(text, /manifold_outbox_points_total\{historian="h1",result="spilled"\} 3/);
  assert.match(text, /manifold_contract_violations_total\{contract="c1"\} 2/);
  assert.match(text, /manifold_binding_published_total\{binding="b1"\} 7/);
  m.shutdown();
});

// ---- sparkplug encoder --------------------------------------------------------------

test('sparkplug encoder round-trips through our own decoder', () => {
  const buf = encodePayload({
    seq: 7,
    metrics: [
      { name: 'bdSeq', value: 42, isBdSeq: true },
      { name: 'rpm', value: 903.5 },
      { name: 'running', value: true },
      { name: 'state', value: 'FILLING' }
    ]
  });
  const decoder = new SparkplugDecoder();
  const decoded = decoder.decode(buf);
  assert.strictEqual(Number(decoded.seq), 7);
  const byName = Object.fromEntries(decoded.metrics.map((m) => [m.name, m.value]));
  assert.strictEqual(Number(byName.bdSeq), 42);
  assert.strictEqual(byName.rpm, 903.5);
  assert.strictEqual(byName.running, true);
  assert.strictEqual(byName.state, 'FILLING');
});

// ---- tag bindings --------------------------------------------------------------------

test('opcQuality maps status codes; targetTopic slugs names into templates', () => {
  assert.strictEqual(opcQuality('Good'), 192);
  assert.strictEqual(opcQuality('UncertainLastUsableValue'), 64);
  assert.strictEqual(opcQuality('BadNodeIdUnknown'), 0);
  assert.strictEqual(targetTopic('site/area/{name}', 'Motor RPM'), 'site/area/Motor_RPM');
  assert.strictEqual(targetTopic('site/area', 'temp/1'), 'site/area/temp_1');
});

test('opcua binding publishes with deadband suppression and TVQ envelope', async () => {
  const m = new MqttManager({ emit() {} });
  const published = [];
  m.publish = async (brokerId, topic, payload, opts) => {
    published.push({ brokerId, topic, payload, opts });
  };
  const opcua = new EventEmitter();
  opcua.monitor = async () => ({ status: 'monitoring' });
  const binding = {
    id: 'tb1',
    enabled: true,
    source: { type: 'opcua', connectionId: 'c1', tags: [{ address: 'ns=2;s=Motor.RPM', name: 'Motor RPM' }] },
    target: { mode: 'mqtt', brokerId: 'b1', pathTemplate: 'uns/line1/{name}', format: 'envelope', deadband: 5, retain: true }
  };
  const tb = new TagBindings({
    mqttManager: m,
    opcuaManager: opcua,
    profiles: fakeProfiles({ bindings: { tb1: binding } }),
    sparkplugPublisher: null
  });
  tb.start();
  await new Promise((r) => setImmediate(r)); // let syncMonitors settle

  const evt = (value, status = 'Good') => ({ connectionId: 'c1', nodeId: 'ns=2;s=Motor.RPM', value, status, sourceTimestamp: new Date().toISOString() });
  opcua.emit('value', evt(100));
  opcua.emit('value', evt(102)); // inside deadband 5 → suppressed
  opcua.emit('value', evt(110, 'UncertainSensorCal')); // outside → published, quality 64
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(published.length, 2);
  assert.strictEqual(published[0].topic, 'uns/line1/Motor_RPM');
  assert.deepStrictEqual({ v: published[0].payload.v, q: published[0].payload.q }, { v: 100, q: 192 });
  assert.strictEqual(published[1].payload.q, 64);
  assert.strictEqual(published[1].opts.retain, true);
  const s = tb.getStatus().tb1;
  assert.strictEqual(s.published, 2);
  assert.strictEqual(s.suppressed, 1);
  tb.stop();
  m.shutdown();
});

test('sparkplug-source binding republishes selected metrics to UNS paths', async () => {
  const m = new MqttManager({ emit() {} });
  const published = [];
  m.publish = async (brokerId, topic, payload) => {
    published.push({ topic, payload });
  };
  const binding = {
    id: 'tb2',
    enabled: true,
    source: { type: 'sparkplug', brokerId: 'b1', group: 'G', edge: 'E1', device: 'D1', metrics: ['temp'] },
    target: { mode: 'mqtt', brokerId: 'b1', pathTemplate: 'uns/plant/{name}', format: 'plain' }
  };
  const tb = new TagBindings({
    mqttManager: m,
    opcuaManager: null,
    profiles: fakeProfiles({ bindings: { tb2: binding } }),
    sparkplugPublisher: null
  });
  tb.start();
  m.emit('message', msg('b1', 'spBv1.0/G/DDATA/E1/D1', 'x', {
    sparkplug: { metrics: [{ name: 'temp', value: 21 }, { name: 'ignored', value: 9 }] }
  }));
  m.emit('message', msg('b1', 'spBv1.0/G/DDATA/E1/D2', 'x', {
    sparkplug: { metrics: [{ name: 'temp', value: 99 }] } // wrong device
  }));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(published.length, 1);
  assert.strictEqual(published[0].topic, 'uns/plant/temp');
  assert.strictEqual(published[0].payload, 21);
  tb.stop();
  m.shutdown();
});
