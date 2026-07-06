const { test } = require('node:test');
const assert = require('node:assert');

const { computeLayout, listEngines, NODE_CAP } = require('../services/graphLayout');

// A small hierarchical graph with ids that contain characters (":", "/") that
// would break naive DOT emission — exercises the alias mapping.
const graph = {
  nodes: [
    { id: 'broker:b1' },
    { id: 'topic:b1:factory' },
    { id: 'topic:b1:factory/line1' },
    { id: 'topic:b1:factory/line2' },
    { id: 'topic:b1:factory/line1/temp' }
  ],
  links: [
    { source: 'broker:b1', target: 'topic:b1:factory' },
    { source: 'topic:b1:factory', target: 'topic:b1:factory/line1' },
    { source: 'topic:b1:factory', target: 'topic:b1:factory/line2' },
    { source: 'topic:b1:factory/line1', target: 'topic:b1:factory/line1/temp' }
  ]
};

test('listEngines advertises graphviz + fcose engines', () => {
  const engines = listEngines();
  for (const e of ['dot', 'sfdp', 'twopi', 'circo', 'fcose']) {
    assert.ok(engines.includes(e), `expected engine ${e}`);
  }
});

test('graphviz dot layout returns a position for every node', async () => {
  const out = await computeLayout(graph, { engine: 'dot' });
  assert.strictEqual(out.engine, 'dot');
  assert.strictEqual(out.count, 5);
  for (const n of graph.nodes) {
    const p = out.positions[n.id];
    assert.ok(p, `missing position for ${n.id}`);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
});

test('dot layout is hierarchical: root sits above its descendants (y-down)', async () => {
  const out = await computeLayout(graph, { engine: 'dot', direction: 'TB' });
  const root = out.positions['broker:b1'];
  const leaf = out.positions['topic:b1:factory/line1/temp'];
  // top-left origin, y increases downward → deeper nodes have larger y
  assert.ok(leaf.y > root.y, `expected leaf.y (${leaf.y}) > root.y (${root.y})`);
});

test('fcose layout returns finite, distinct positions', async () => {
  const out = await computeLayout(graph, { engine: 'fcose' });
  assert.strictEqual(out.engine, 'fcose');
  // fcose is randomized; assert distinct (x,y) points rather than x alone so a
  // rare axis-aligned draw doesn't flake the test.
  const points = graph.nodes.map((n) => `${out.positions[n.id].x.toFixed(3)},${out.positions[n.id].y.toFixed(3)}`);
  assert.ok(new Set(points).size > 1, 'expected nodes to be spread out');
  for (const n of graph.nodes) {
    assert.ok(Number.isFinite(out.positions[n.id].x) && Number.isFinite(out.positions[n.id].y));
  }
});

test('positions are shifted to a non-negative origin', async () => {
  const out = await computeLayout(graph, { engine: 'twopi' });
  for (const p of Object.values(out.positions)) {
    assert.ok(p.x >= 0 && p.y >= 0, 'coordinates should be >= 0');
  }
});

test('empty graph yields an empty layout, not an error', async () => {
  const out = await computeLayout({ nodes: [], links: [] }, { engine: 'dot' });
  assert.strictEqual(out.count, 0);
  assert.deepStrictEqual(out.positions, {});
});

test('unknown engine is rejected', async () => {
  await assert.rejects(() => computeLayout(graph, { engine: 'nope' }), /unknown layout engine/);
});

test('missing nodes[] is rejected', async () => {
  await assert.rejects(() => computeLayout({}, { engine: 'dot' }), /nodes\[\] is required/);
});

test('graphs above the engine node cap are rejected', async () => {
  const big = { nodes: [], links: [] };
  const over = NODE_CAP.dot + 1;
  for (let i = 0; i < over; i++) big.nodes.push({ id: `n${i}` });
  await assert.rejects(() => computeLayout(big, { engine: 'dot' }), /too large/);
});
