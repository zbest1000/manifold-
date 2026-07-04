'use strict';

/**
 * Server-side graph layout engine.
 *
 * Best-in-class layout algorithms — Graphviz (`dot` hierarchical, `sfdp`
 * scalable force, `twopi` radial, `circo` circular, `neato`/`fdp` spring) and
 * Cytoscape's `fcose` (organic, cluster-aware) — computed HEADLESS on the server
 * and returned as plain coordinates. The client renders those coordinates with
 * its existing canvas / WebGL / 3D renderers, so we get world-class layouts
 * without adding a second rendering engine to the frontend.
 *
 * These are one-shot batch layouts, intended for the static / hierarchical views
 * (OPC UA address spaces, i3X object graphs) and for an explicit "beautify"
 * action on the MQTT graph — NOT the live-streaming incremental path (that stays
 * on d3-force / the deterministic radial layout).
 *
 * Input graph shape matches the client builders: { nodes: [{ id, ... }],
 * links: [{ source, target }] }. Node ids are aliased to integers before they
 * reach Graphviz/Cytoscape so arbitrary characters in topic ids never break
 * parsing, then mapped back on the way out.
 */

const GRAPHVIZ_ENGINES = new Set(['dot', 'sfdp', 'neato', 'fdp', 'twopi', 'circo']);
const FORCE_ENGINES = new Set(['fcose']);

// Per-engine node ceilings. `dot`'s crossing-minimisation is the most expensive,
// so it is capped tightest; the scalable engines allow much larger graphs. Above
// the ceiling the client keeps its incremental/deterministic layout instead.
const NODE_CAP = {
  dot: 4000,
  twopi: 6000,
  circo: 6000,
  neato: 4000,
  fdp: 4000,
  sfdp: 30000,
  fcose: 15000
};

let vizPromise = null;
function getViz() {
  if (!vizPromise) {
    const { instance } = require('@viz-js/viz');
    vizPromise = instance();
  }
  return vizPromise;
}

let cyLib = null;
function getCytoscape() {
  if (!cyLib) {
    cyLib = require('cytoscape');
    cyLib.use(require('cytoscape-fcose'));
  }
  return cyLib;
}

function listEngines() {
  return [...GRAPHVIZ_ENGINES, ...FORCE_ENGINES];
}

function normalizeGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes)) {
    throw new Error('graph.nodes[] is required');
  }
  const nodes = graph.nodes.filter((n) => n && n.id != null);
  const links = Array.isArray(graph.links) ? graph.links : [];
  const alias = new Map(); // original id -> n<idx>
  nodes.forEach((n, i) => alias.set(String(n.id), `n${i}`));

  const edges = [];
  for (const l of links) {
    const s = alias.get(String(l.source));
    const t = alias.get(String(l.target));
    if (s && t && s !== t) edges.push([s, t]);
  }
  return { nodes, edges, alias };
}

// Graphviz JSON reports coordinates in points with a bottom-left origin (y up).
// Flip y and shift to a top-left origin so the client can treat them like screen
// space; the client renderer fits/scales to the viewport regardless.
function graphvizLayout(viz, engine, aliasNodes, edges, direction) {
  const lines = ['digraph G {'];
  lines.push(`  graph [rankdir="${direction === 'LR' ? 'LR' : 'TB'}"];`);
  lines.push('  node [shape=point,width=0.1,height=0.1];');
  for (const a of aliasNodes) lines.push(`  ${a};`);
  for (const [s, t] of edges) lines.push(`  ${s} -> ${t};`);
  lines.push('}');
  const dot = lines.join('\n');

  const json = viz.renderJSON(dot, { engine });
  const bb = String(json.bb || '0,0,0,0').split(',').map(Number);
  const height = bb[3] - bb[1] || 1;

  const positions = {};
  for (const obj of json.objects || []) {
    if (!obj.pos || !obj.name) continue;
    const [x, y] = obj.pos.split(',').map(Number);
    positions[obj.name] = { x, y: height - y }; // flip to y-down
  }
  return positions;
}

function fcoseLayout(cytoscape, aliasNodes, edges) {
  const elements = [];
  for (const a of aliasNodes) elements.push({ data: { id: a } });
  edges.forEach(([s, t], i) => elements.push({ data: { id: `e${i}`, source: s, target: t } }));

  // Draft quality on larger graphs — 'default' does many more iterations and
  // gets very slow past a few hundred nodes, which is too long for a one-shot
  // interactive "beautify". Draft still produces a clean, cluster-aware layout.
  const large = aliasNodes.length > 800;
  const cy = cytoscape({ headless: true, styleEnabled: false, elements });
  cy.layout({
    name: 'fcose',
    animate: false,
    randomize: true,
    quality: large ? 'draft' : 'default',
    numIter: large ? 1200 : 2500,
    nodeRepulsion: 6000,
    idealEdgeLength: 60,
    nodeSeparation: 75
  }).run();

  const positions = {};
  cy.nodes().forEach((n) => {
    const p = n.position();
    positions[n.id()] = { x: p.x, y: p.y };
  });
  cy.destroy();
  return positions;
}

// Shift so the top-left of the bounding box sits at (0,0); keeps coordinates in a
// sane, non-negative range. Absolute scale is irrelevant — the client fits.
function shiftToOrigin(byAlias) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of Object.values(byAlias)) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { positions: byAlias, width: 0, height: 0 };
  for (const p of Object.values(byAlias)) {
    p.x -= minX;
    p.y -= minY;
  }
  return { positions: byAlias, width: maxX - minX, height: maxY - minY };
}

/**
 * Compute a layout. Returns { engine, count, width, height, positions }, where
 * positions maps the ORIGINAL node id -> { x, y }.
 */
async function computeLayout(graph, options = {}) {
  const engine = String(options.engine || 'dot');
  if (!GRAPHVIZ_ENGINES.has(engine) && !FORCE_ENGINES.has(engine)) {
    throw new Error(`unknown layout engine "${engine}" (expected one of: ${listEngines().join(', ')})`);
  }

  const { nodes, edges, alias } = normalizeGraph(graph);
  const cap = NODE_CAP[engine] || 4000;
  if (nodes.length > cap) {
    throw new Error(`graph too large for "${engine}" layout: ${nodes.length} nodes > ${cap} cap`);
  }
  if (nodes.length === 0) {
    return { engine, count: 0, width: 0, height: 0, positions: {} };
  }

  const aliasNodes = nodes.map((_, i) => `n${i}`);
  let byAlias;
  if (GRAPHVIZ_ENGINES.has(engine)) {
    const viz = await getViz();
    byAlias = graphvizLayout(viz, engine, aliasNodes, edges, options.direction);
  } else {
    byAlias = fcoseLayout(getCytoscape(), aliasNodes, edges);
  }

  const { width, height } = shiftToOrigin(byAlias);

  // Map integer aliases back to original node ids.
  const positions = {};
  const aliasToId = new Map();
  nodes.forEach((n, i) => aliasToId.set(`n${i}`, String(n.id)));
  for (const [a, p] of Object.entries(byAlias)) {
    const id = aliasToId.get(a);
    if (id != null) positions[id] = p;
  }

  return { engine, count: nodes.length, width, height, positions };
}

module.exports = { computeLayout, listEngines, NODE_CAP };
