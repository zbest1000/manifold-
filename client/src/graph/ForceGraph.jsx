import { useEffect, useRef, useCallback } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY
} from 'd3-force';
import { select } from 'd3-selection';
import { zoom, zoomIdentity } from 'd3-zoom';
import { drag } from 'd3-drag';
import { GRAPH_STYLES, LAYOUTS } from './graphStyles';
import { groupColor } from './buildGraph';

/**
 * Canvas-based force-directed graph with pan/zoom, drag, hover and selection.
 *
 * Rendering is done on a 2D canvas for smoothness with hundreds of nodes; the
 * visual language is driven entirely by the selected style preset so switching
 * styles restyles the whole graph instantly without touching layout.
 */
export default function ForceGraph({
  data,
  styleId = 'constellation',
  layoutId = 'organic',
  selectedId = null,
  onSelect,
  onExpand
}) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const simRef = useRef(null);
  const transformRef = useRef(zoomIdentity);
  const hoverRef = useRef(null);
  const nodesRef = useRef([]);
  const linksRef = useRef([]);
  const dprRef = useRef(1);

  const style = GRAPH_STYLES[styleId] || GRAPH_STYLES.constellation;
  const layout = LAYOUTS[layoutId] || LAYOUTS.organic;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = dprRef.current;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const t = transformRef.current;
    const nodes = nodesRef.current;
    const links = linksRef.current;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background
    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, width, height);

    // Optional grid drawn in screen space, offset by pan
    if (style.grid) {
      const size = style.grid.size * t.k;
      const offX = t.x % size;
      const offY = t.y % size;
      ctx.strokeStyle = style.grid.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = offX; x < width; x += size) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let y = offY; y < height; y += size) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();
    }

    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    const hover = hoverRef.current;
    const neighbors = new Set();
    if (hover) {
      for (const l of links) {
        if (l.source.id === hover.id) neighbors.add(l.target.id);
        if (l.target.id === hover.id) neighbors.add(l.source.id);
      }
    }

    // Links
    ctx.lineWidth = style.link.width / t.k;
    for (const l of links) {
      const active = hover && (l.source.id === hover.id || l.target.id === hover.id);
      ctx.strokeStyle = active ? style.linkHighlight : style.link.color;
      ctx.beginPath();
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
      ctx.stroke();
    }

    // Nodes
    const showLabels = t.k >= style.showLabelsAtZoom;
    for (const n of nodes) {
      const r = nodeRadius(n, style);
      const color = groupColor(n.group, style.palette);
      const dim = hover && hover.id !== n.id && !neighbors.has(n.id);

      ctx.globalAlpha = dim ? 0.35 : 1;

      if (style.node.glow) {
        ctx.shadowColor = color;
        ctx.shadowBlur = style.node.glow;
      } else {
        ctx.shadowBlur = 0;
      }

      ctx.fillStyle = color;
      ctx.beginPath();
      if (style.node.square) {
        const s = r * 1.7;
        ctx.rect(n.x - s / 2, n.y - s / 2, s, s);
      } else {
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.shadowBlur = 0;

      if (style.node.strokeWidth) {
        ctx.lineWidth = style.node.strokeWidth / t.k;
        ctx.strokeStyle = style.node.stroke;
        ctx.stroke();
      }

      if (n.id === selectedId) {
        ctx.lineWidth = 2.5 / t.k;
        ctx.strokeStyle = style.selectedRing;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 5 / t.k, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.globalAlpha = 1;

      if (showLabels && !dim) {
        ctx.font = style.labelFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const label = n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label;
        ctx.lineWidth = 3 / t.k;
        ctx.strokeStyle = style.label.halo;
        ctx.strokeText(label, n.x, n.y + r + 2);
        ctx.fillStyle = style.label.color;
        ctx.fillText(label, n.x, n.y + r + 2);
      }
    }

    ctx.restore();
  }, [style, selectedId]);

  // Build / rebuild the simulation when the graph data or layout changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;

    // Preserve positions of nodes that persist across updates
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const nodes = data.nodes.map((n) => {
      const old = prev.get(n.id);
      return old ? { ...n, x: old.x, y: old.y, vx: old.vx, vy: old.vy } : { ...n };
    });
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const links = data.links
      .filter((l) => nodeById.has(l.source) && nodeById.has(l.target))
      .map((l) => ({ source: l.source, target: l.target }));

    nodesRef.current = nodes;
    linksRef.current = links;

    if (simRef.current) simRef.current.stop();

    const sim = forceSimulation(nodes)
      .force('link', forceLink(links).id((d) => d.id).distance(layout.linkDistance).strength(0.7))
      .force('charge', forceManyBody().strength(layout.charge))
      .force('center', forceCenter(0, 0))
      .force('collide', forceCollide().radius((d) => nodeRadius(d, style) + 4))
      .force('x', forceX(0).strength(layout.gravity))
      .force('y', forceY(0).strength(layout.gravity))
      .alpha(0.9)
      .alphaDecay(0.028)
      .on('tick', draw);

    simRef.current = sim;
    return () => sim.stop();
    // style intentionally excluded: restyling should not rebuild the simulation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, layout, draw]);

  // Redraw on style/selection change without disturbing layout.
  useEffect(() => {
    draw();
  }, [draw]);

  // Canvas sizing + zoom/drag/hover wiring (once).
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      const { width, height } = wrap.getBoundingClientRect();
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      draw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const sel = select(canvas);

    const zoomBehavior = zoom()
      .scaleExtent([0.1, 6])
      .on('zoom', (event) => {
        transformRef.current = event.transform;
        draw();
      });
    sel.call(zoomBehavior);

    const toGraphCoords = (event) => {
      const rect = canvas.getBoundingClientRect();
      const t = transformRef.current;
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      return { x: (px - t.x) / t.k, y: (py - t.y) / t.k };
    };

    const pick = (gx, gy) => {
      const nodes = nodesRef.current;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const r = nodeRadius(n, style) + 4;
        if ((n.x - gx) ** 2 + (n.y - gy) ** 2 <= r * r) return n;
      }
      return null;
    };

    const dragBehavior = drag()
      .container(canvas)
      .subject((event) => {
        const { x, y } = toGraphCoords(event.sourceEvent);
        return pick(x, y);
      })
      .on('start', (event) => {
        if (!event.subject) return;
        if (simRef.current) simRef.current.alphaTarget(0.25).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      })
      .on('drag', (event) => {
        if (!event.subject) return;
        const t = transformRef.current;
        const rect = canvas.getBoundingClientRect();
        event.subject.fx = (event.sourceEvent.clientX - rect.left - t.x) / t.k;
        event.subject.fy = (event.sourceEvent.clientY - rect.top - t.y) / t.k;
      })
      .on('end', (event) => {
        if (!event.subject) return;
        if (simRef.current) simRef.current.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
      });
    // Drag filters out clicks; only real drags move nodes
    sel.call(dragBehavior);

    let downPos = null;
    const onDown = (e) => {
      downPos = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e) => {
      if (!downPos) return;
      const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
      downPos = null;
      if (moved > 5) return; // was a drag/pan, not a click
      const { x, y } = toGraphCoords(e);
      const hit = pick(x, y);
      if (hit && onSelect) onSelect(hit);
    };
    const onDblClick = (e) => {
      const { x, y } = toGraphCoords(e);
      const hit = pick(x, y);
      if (hit && onExpand) onExpand(hit);
    };
    const onMove = (e) => {
      const { x, y } = toGraphCoords(e);
      const hit = pick(x, y);
      if (hit !== hoverRef.current) {
        hoverRef.current = hit;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
        draw();
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('pointermove', onMove);

    return () => {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('pointermove', onMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="graph-canvas" />
    </div>
  );
}

function nodeRadius(n, style) {
  const base = style.nodeMinRadius;
  const scaled = base + Math.sqrt(n.degree || 0) * 3;
  if (n.kind === 'broker' || n.kind === 'opcua-server') return style.nodeMaxRadius;
  return Math.min(scaled, style.nodeMaxRadius);
}
