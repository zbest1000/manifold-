const { test } = require('node:test');
const assert = require('node:assert');

const SparkplugRegistry = require('../services/sparkplugRegistry');

test('registry builds Group → Edge Node → Device topology from topics', () => {
  const r = new SparkplugRegistry();
  r.update('spBv1.0/Plant1/NBIRTH/EdgeA', { metrics: [{ name: 'bdSeq' }] }, 1000);
  r.update('spBv1.0/Plant1/DBIRTH/EdgeA/Pump7', { metrics: [{ name: 'Temperature' }, { name: 'RPM' }] }, 1001);

  const t = r.toJSON();
  assert.strictEqual(t.summary.groups, 1);
  assert.strictEqual(t.summary.edgeNodes, 1);
  assert.strictEqual(t.summary.devices, 1);

  const edge = t.groups[0].edgeNodes[0];
  assert.strictEqual(edge.id, 'EdgeA');
  assert.ok(edge.online, 'edge online after NBIRTH');
  assert.deepStrictEqual(edge.metrics, ['bdSeq']);

  const dev = edge.devices[0];
  assert.strictEqual(dev.id, 'Pump7');
  assert.ok(dev.online, 'device online after DBIRTH');
  assert.deepStrictEqual(dev.metrics.sort(), ['RPM', 'Temperature']);
});

test('NDEATH / DDEATH mark endpoints offline', () => {
  const r = new SparkplugRegistry();
  r.update('spBv1.0/G/NBIRTH/E', null, 1);
  r.update('spBv1.0/G/DBIRTH/E/D', null, 2);
  r.update('spBv1.0/G/DDEATH/E/D', null, 3);
  r.update('spBv1.0/G/NDEATH/E', null, 4);

  const edge = r.toJSON().groups[0].edgeNodes[0];
  assert.strictEqual(edge.online, false);
  assert.strictEqual(edge.devices[0].online, false);
});

test('metric names accumulate across BIRTH and DATA', () => {
  const r = new SparkplugRegistry();
  r.update('spBv1.0/G/DBIRTH/E/D', { metrics: [{ name: 'a' }] }, 1);
  r.update('spBv1.0/G/DDATA/E/D', { metrics: [{ name: 'b' }] }, 2);
  const dev = r.toJSON().groups[0].edgeNodes[0].devices[0];
  assert.deepStrictEqual(dev.metrics.sort(), ['a', 'b']);
  assert.strictEqual(dev.msgCount, 2);
});

test('non-Sparkplug topics are ignored', () => {
  const r = new SparkplugRegistry();
  r.update('factory/line1/temp', { metrics: [{ name: 'x' }] }, 1);
  assert.ok(r.isEmpty());
});

test('NDEATH cascades offline to all devices under the edge node', () => {
  const r = new SparkplugRegistry();
  r.update('spBv1.0/G/NBIRTH/E', null, 1);
  r.update('spBv1.0/G/DBIRTH/E/D1', null, 2);
  r.update('spBv1.0/G/DBIRTH/E/D2', null, 3);
  r.update('spBv1.0/G/NDEATH/E', null, 4);

  const edge = r.toJSON().groups[0].edgeNodes[0];
  assert.strictEqual(edge.online, false);
  for (const d of edge.devices) {
    assert.strictEqual(d.online, false, `device ${d.id} must be offline after edge NDEATH`);
    assert.strictEqual(d.lastDeath, 4);
  }
});
