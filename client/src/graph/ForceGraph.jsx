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
  onExpand,
  flow = false,
  activitySource = null
}) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const simRef = useRef(null);
  const transformRef = useRef(zoomIdentity);
  const hoverRef = useRef(null);
  const nodesRef = useRef([]);
  const linksRef = useRef([]);
  const dprRef = useRef(1);
  const centeredRef = useRef(false);

  // Live message-flow animation state (all imperative, off the React tree)
  const nodeByIdRef = useRef(new Map());
  const parentOfRef = useRef(new Map()); // childId -> parentId, for root→leaf paths
  const particlesRef = useRef([]); // travelling dots: { nodeIds, progress, speed }
  const pulseRef = useRef(new Map()); // nodeId -> ring strength (0..1)
  const rateRef = useRef(new Map()); // nodeId -> recent activity (drives glow)
  const rafRef = useRef(0);
  const lastFrameRef = useRef(0);
  const drawRef = useRef(() => {});

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

      // Recent message activity brightens a node's glow without touching its
      // physical radius (which would disturb collision/layout).
      const activity = rateRef.current.get(n.id) || 0;
      const activeGlow = Math.min(activity, 4) * 6;
      const glow = (style.node.glow || 0) + activeGlow;
      if (glow > 0) {
        ctx.shadowColor = color;
        ctx.shadowBlur = glow;
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

    // Live-flow overlay: expanding pulse rings on active nodes + travelling dots.
    const byId = nodeByIdRef.current;
    if (pulseRef.current.size) {
      ctx.strokeStyle = style.linkHighlight;
      for (const [id, s] of pulseRef.current) {
        const n = byId.get(id);
        if (!n) continue;
        const r = nodeRadius(n, style);
        ctx.globalAlpha = s * 0.85;
        ctx.lineWidth = 2 / t.k;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 3 + (1 - s) * 16, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    if (particlesRef.current.length) {
      ctx.fillStyle = style.linkHighlight;
      ctx.shadowColor = style.linkHighlight;
      ctx.shadowBlur = 8;
      const dot = 3.5 / t.k;
      for (const p of particlesRef.current) {
        const pos = particlePosition(p, byId);
        if (!pos) continue;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, dot, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }, [style, selectedId]);

  // Keep the animation loop pointed at the latest draw (recreated on restyle).
  useEffect(() => {
    drawRef.current = draw;
  }, [draw]);

  // Register a burst of activity on a node: pulse the node, send a dot along the
  // path from the root down to it, and bump its glow. Drives the animation loop.
  const pulse = useCallback(
    (nodeId) => {
      const byId = nodeByIdRef.current;
      if (!byId.has(nodeId)) return;

      // Walk parent pointers up to the root to get the root→node path
      const path = [nodeId];
      let cur = nodeId;
      const guard = new Set([nodeId]);
      while (parentOfRef.current.has(cur)) {
        const parent = parentOfRef.current.get(cur);
        if (guard.has(parent)) break;
        path.push(parent);
        guard.add(parent);
        cur = parent;
      }
      path.reverse(); // root ... leaf

      pulseRef.current.set(nodeId, 1);
      rateRef.current.set(nodeId, (rateRef.current.get(nodeId) || 0) + 1);

      if (path.length >= 2) {
        const dur = 450 + (path.length - 1) * 130; // ms, longer paths take longer
        particlesRef.current.push({ nodeIds: path, progress: 0, speed: 1 / dur });
        if (particlesRef.current.length > 200) particlesRef.current.shift();
      }
      startAnimation();
    },
    // startAnimation is stable (defined below via ref-free closure)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const startAnimation = useCallback(() => {
    if (rafRef.current) return;
    lastFrameRef.current = 0;
    const step = (ts) => {
      const dt = lastFrameRef.current ? Math.min(ts - lastFrameRef.current, 50) : 16;
      lastFrameRef.current = ts;

      // Advance travelling dots
      const particles = particlesRef.current;
      for (let i = particles.length - 1; i >= 0; i--) {
        particles[i].progress += dt * particles[i].speed;
        if (particles[i].progress >= 1) particles.splice(i, 1);
      }
      // Decay pulse rings
      const pulseDecay = Math.pow(0.9, dt / 16);
      for (const [id, s] of pulseRef.current) {
        const next = s * pulseDecay;
        if (next < 0.04) pulseRef.current.delete(id);
        else pulseRef.current.set(id, next);
      }
      // Decay activity glow (slower)
      const rateDecay = Math.pow(0.985, dt / 16);
      for (const [id, v] of rateRef.current) {
        const next = v * rateDecay;
        if (next < 0.05) rateRef.current.delete(id);
        else rateRef.current.set(id, next);
      }

      drawRef.current();

      if (particles.length || pulseRef.current.size || rateRef.current.size) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = 0;
        lastFrameRef.current = 0;
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, []);

  // Subscribe to the activity bus while live flow is enabled.
  useEffect(() => {
    if (!flow || !activitySource) return undefined;
    const unsub = activitySource(pulse);
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [flow, activitySource, pulse]);

  // Stop the animation loop and clear transient state when flow is turned off.
  useEffect(() => {
    if (flow) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    particlesRef.current = [];
    pulseRef.current.clear();
    rateRef.current.clear();
    draw();
  }, [flow, draw]);

  // Cancel any pending frame on unmount.
  useEffect(() => () => rafRef.current && cancelAnimationFrame(rafRef.current), []);

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

    // Live-flow lookups: id→node and child→parent (edges run parent→child).
    // Built from the string ids before forceLink() mutates them into objects.
    const parentOf = new Map();
    for (const l of links) parentOf.set(l.target, l.source);
    nodeByIdRef.current = nodeById;
    parentOfRef.current = parentOf;

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

    const sel = select(canvas);

    const zoomBehavior = zoom()
      .scaleExtent([0.1, 6])
      .on('zoom', (event) => {
        transformRef.current = event.transform;
        draw();
      });
    sel.call(zoomBehavior);

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      const { width, height } = wrap.getBoundingClientRect();
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      // The simulation centers the graph at graph-origin (0,0); translate the
      // view so that origin sits at the viewport centre on first layout.
      if (!centeredRef.current && width > 0 && height > 0) {
        centeredRef.current = true;
        const initial = zoomIdentity.translate(width / 2, height / 2);
        transformRef.current = initial;
        sel.call(zoomBehavior.transform, initial);
      }
      draw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

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

// Interpolate a travelling dot's position along its root→leaf node path.
function particlePosition(p, byId) {
  const segments = p.nodeIds.length - 1;
  if (segments < 1) return null;
  const f = Math.max(0, Math.min(p.progress, 1)) * segments;
  const i = Math.min(Math.floor(f), segments - 1);
  const local = f - i;
  const a = byId.get(p.nodeIds[i]);
  const b = byId.get(p.nodeIds[i + 1]);
  if (!a || !b) return null;
  return { x: a.x + (b.x - a.x) * local, y: a.y + (b.y - a.y) * local };
}
