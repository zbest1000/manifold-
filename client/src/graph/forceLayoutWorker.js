/**
 * Web Worker: batch force-directed layout for big graphs.
 *
 * Receives { nodes: [{ id }], links: [{ source, target }] }, runs a bounded
 * d3-force simulation off the main thread, and posts back
 * { positions: { id: { x, y } }, count } — or { error } if the graph exceeds
 * the node cap. The number of ticks scales down with graph size so even large
 * namespaces settle in a few seconds.
 */
import { forceSimulation, forceManyBody, forceLink, forceCenter } from 'd3-force';

const MAX_NODES = 30000;

function tickCount(n) {
  if (n <= 2000) return 300;
  if (n <= 10000) return 120;
  return 60;
}

self.onmessage = (e) => {
  const { nodes = [], links = [] } = e.data || {};

  if (nodes.length > MAX_NODES) {
    self.postMessage({
      error: `Force layout supports up to ${MAX_NODES.toLocaleString()} nodes (this graph has ${nodes.length.toLocaleString()}).`
    });
    return;
  }

  const simNodes = nodes.map((n) => ({ id: n.id }));
  const idSet = new Set(simNodes.map((n) => n.id));
  const simLinks = links
    .filter((l) => idSet.has(l.source) && idSet.has(l.target))
    .map((l) => ({ source: l.source, target: l.target }));

  const sim = forceSimulation(simNodes)
    .force('link', forceLink(simLinks).id((d) => d.id).distance(40).strength(0.5))
    // distanceMax bounds the many-body cost so 30k-node graphs stay tractable.
    .force('charge', forceManyBody().strength(-60).theta(0.9).distanceMax(900))
    .force('center', forceCenter(0, 0))
    .stop();

  const ticks = tickCount(simNodes.length);
  for (let i = 0; i < ticks; i++) sim.tick();

  const positions = {};
  for (const n of simNodes) positions[n.id] = { x: n.x, y: n.y };
  self.postMessage({ positions, count: simNodes.length });
};
