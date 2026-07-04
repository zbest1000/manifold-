import { useEffect, useRef } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import { GRAPH_STYLES } from './graphStyles';
import { groupColor, PROTOCOL_COLORS } from './buildGraph';

/**
 * Sigma.js (WebGL) renderer for the "show all" view — an alternative to the
 * built-in WebGLGraph. Sigma is a mature, purpose-built large-graph renderer:
 * it draws nodes and edges on the GPU and adds zoom-dependent labels and native
 * camera controls for free, which our hand-rolled WebGL renderer does not. It is
 * offered as a selectable renderer for the massive show-all case; the 2D
 * ForceGraph remains the default for normal-sized graphs.
 *
 * Props mirror WebGLGraph so the two are drop-in interchangeable.
 */
export default function SigmaGraph({ data, styleId = 'constellation', selectedId = null, onSelect, colorByProtocol = false, labelDensity = 0.5, positions = null }) {
  const wrapRef = useRef(null);
  const sigmaRef = useRef(null);
  const selectedRef = useRef(selectedId);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  selectedRef.current = selectedId;

  // (Re)build the graph + renderer whenever the data or style changes.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !data) return undefined;

    const style = GRAPH_STYLES[styleId] || GRAPH_STYLES.constellation;
    const colorFor = (n) =>
      colorByProtocol && n.protocol ? PROTOCOL_COLORS[n.protocol] || style.palette[0] : groupColor(n.group, style.palette);

    const graph = new Graph({ multi: false, type: 'mixed' });
    // Server-computed coordinates (organic sfdp/fcose) when provided, else the
    // built-in deterministic radial layout.
    const layout = positions
      ? new Map(data.nodes.map((n) => [n.id, positions[n.id] || { x: 0, y: 0 }]))
      : radialLayout(data.nodes, data.links);

    for (const n of data.nodes) {
      const p = layout.get(n.id) || { x: 0, y: 0 };
      const degree = n.degree || 0;
      graph.addNode(n.id, {
        x: p.x,
        y: p.y,
        size: Math.max(2, Math.min(14, 3 + Math.sqrt(degree) * 1.6)),
        color: colorFor(n),
        label: n.label || n.id
      });
    }
    for (let i = 0; i < data.links.length; i++) {
      const l = data.links[i];
      if (graph.hasNode(l.source) && graph.hasNode(l.target) && !graph.hasEdge(l.source, l.target)) {
        graph.addEdgeWithKey(`e${i}`, l.source, l.target, { color: style.link.color, size: 0.4 });
      }
    }

    // Labels and connection lines both matter, so keep them on at every size.
    // For very large graphs, thin the label pass (bigger grid cells, higher size
    // threshold) so only the more-connected nodes get labels and per-frame work
    // stays bounded — Sigma still only draws the labels currently on screen.
    const huge = data.nodes.length > 20_000;
    const ls = labelSettings(labelDensity);
    const renderer = new Sigma(graph, wrap, {
      allowInvalidContainer: true,
      renderEdgeLabels: false,
      renderLabels: ls.renderLabels,
      defaultNodeColor: style.palette[0],
      defaultEdgeColor: style.link.color,
      labelColor: { color: style.label?.color || '#e5e7eb' },
      labelDensity: ls.labelDensity,
      labelGridCellSize: huge ? 200 : 90,
      labelRenderedSizeThreshold: ls.labelRenderedSizeThreshold,
      zoomToSizeRatioFunction: (x) => x,
      // Dim everything except the selected node + its neighbors when one is picked.
      nodeReducer: (node, attrs) => {
        const sel = selectedRef.current;
        if (!sel) return attrs;
        if (node === sel) return { ...attrs, zIndex: 2, size: attrs.size * 1.6, color: style.palette[1] || attrs.color };
        if (graph.areNeighbors(sel, node)) return { ...attrs, zIndex: 1 };
        return { ...attrs, color: fade(attrs.color), label: '' };
      },
      edgeReducer: (edge, attrs) => {
        const sel = selectedRef.current;
        if (!sel) return attrs;
        const [s, t] = graph.extremities(edge);
        if (s === sel || t === sel) return { ...attrs, color: style.link.color };
        return { ...attrs, hidden: true };
      }
    });

    renderer.on('clickNode', ({ node }) => onSelectRef.current?.(node));
    renderer.on('clickStage', () => onSelectRef.current?.(null));

    sigmaRef.current = renderer;
    wrap.style.background = style.background;

    // Expose readiness + node count for automated verification.
    if (typeof window !== 'undefined') {
      window.__sigmaReady = { nodes: graph.order, edges: graph.size };
    }

    return () => {
      renderer.kill();
      sigmaRef.current = null;
      if (typeof window !== 'undefined') delete window.__sigmaReady;
    };
  }, [data, styleId, colorByProtocol, positions]);

  // Re-render on selection change without rebuilding the graph.
  useEffect(() => {
    sigmaRef.current?.refresh();
  }, [selectedId]);

  // Apply label density live without rebuilding the graph.
  useEffect(() => {
    const r = sigmaRef.current;
    if (!r) return;
    const ls = labelSettings(labelDensity);
    r.setSetting('renderLabels', ls.renderLabels);
    r.setSetting('labelDensity', ls.labelDensity);
    r.setSetting('labelRenderedSizeThreshold', ls.labelRenderedSizeThreshold);
    r.refresh();
  }, [labelDensity]);

  return <div ref={wrapRef} className="absolute inset-0 h-full w-full" />;
}

// Map the density knob (0..1) to Sigma's label settings. Higher density shows
// more labels (denser grid, lower size threshold); 0 turns labels off.
function labelSettings(d) {
  if (d <= 0.001) return { renderLabels: false, labelDensity: 0.2, labelRenderedSizeThreshold: 100 };
  return {
    renderLabels: true,
    labelDensity: 0.2 + d * 1.3,
    labelRenderedSizeThreshold: Math.max(1, 20 - d * 18)
  };
}

// Deterministic radial-tree layout: root(s) at the centre, each depth on a wider
// ring, children spread across the angular slice inherited from their parent.
// O(n), stable, and cheap — matches the layout used by the other big-graph views.
function radialLayout(nodes, links) {
  const childrenOf = new Map();
  const indeg = new Map();
  for (const n of nodes) {
    childrenOf.set(n.id, []);
    indeg.set(n.id, 0);
  }
  for (const l of links) {
    if (childrenOf.has(l.source) && childrenOf.has(l.target)) {
      childrenOf.get(l.source).push(l.target);
      indeg.set(l.target, (indeg.get(l.target) || 0) + 1);
    }
  }
  const roots = nodes.filter((n) => (indeg.get(n.id) || 0) === 0).map((n) => n.id);
  const pos = new Map();
  const RING = 140;
  const seen = new Set();

  const place = (id, depth, a0, a1) => {
    if (seen.has(id)) return;
    seen.add(id);
    const angle = (a0 + a1) / 2;
    const r = depth * RING;
    pos.set(id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    const kids = childrenOf.get(id) || [];
    if (!kids.length) return;
    const step = (a1 - a0) / kids.length;
    for (let i = 0; i < kids.length; i++) place(kids[i], depth + 1, a0 + i * step, a0 + (i + 1) * step);
  };

  const rootStep = (Math.PI * 2) / Math.max(roots.length, 1);
  roots.forEach((id, i) => place(id, i === 0 && roots.length === 1 ? 0 : 1, i * rootStep, (i + 1) * rootStep));
  // Any nodes not reached (cycles) get a deterministic fallback ring.
  let k = 0;
  for (const n of nodes) {
    if (!pos.has(n.id)) {
      const a = (k++ / nodes.length) * Math.PI * 2;
      pos.set(n.id, { x: Math.cos(a) * 2000, y: Math.sin(a) * 2000 });
    }
  }
  return pos;
}

function fade(hex) {
  const c = String(hex).replace('#', '');
  if (c.length !== 6) return 'rgba(120,130,150,0.15)';
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return `rgba(${r},${g},${b},0.12)`;
}
