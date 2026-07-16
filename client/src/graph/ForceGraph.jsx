import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  forceRadial
} from 'd3-force';
import { select } from 'd3-selection';
import { zoom, zoomIdentity } from 'd3-zoom';
import { drag } from 'd3-drag';
import { GRAPH_STYLES, LAYOUTS } from './graphStyles';
import { groupColor, PROTOCOL_COLORS } from './buildGraph';

/**
 * Canvas node graph: pan/zoom, drag, hover, selection, live message-flow
 * animation, activity-weighted sizing, value overlays, search/focus dimming,
 * collapse badges, edge-kind styling, alternate layouts and a minimap.
 *
 * Rendering is on a 2D canvas so it stays smooth with hundreds of nodes; the
 * visual language is driven by the selected style preset. An imperative handle
 * exposes fit-to / export for the surrounding page.
 */
const ForceGraph = forwardRef(function ForceGraph(
  {
    data,
    styleId = 'constellation',
    layoutId = 'organic',
    selectedId = null,
    onSelect,
    onExpand,
    flow = false,
    activitySource = null,
    activitySize = false,
    nodeValues = null,
    valueZoom = 1.1,
    matchIds = null,
    focusId = null,
    minimap = false,
    colorByProtocol = false
  },
  ref
) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const simRef = useRef(null);
  const transformRef = useRef(zoomIdentity);
  const hoverRef = useRef(null);
  const nodesRef = useRef([]);
  const linksRef = useRef([]);
  const dprRef = useRef(1);
  const sizeRef = useRef({ w: 0, h: 0 });
  const centeredRef = useRef(false);
  const selRef = useRef(null);
  const zoomRef = useRef(null);
  const layoutModeRef = useRef('force');

  // Live message-flow animation state (all imperative, off the React tree)
  const nodeByIdRef = useRef(new Map());
  const parentOfRef = useRef(new Map());
  const particlesRef = useRef([]);
  const pulseRef = useRef(new Map());
  const rateRef = useRef(new Map());
  const rafRef = useRef(0);
  const lastFrameRef = useRef(0);
  const drawRef = useRef(() => {});
  const bigRef = useRef(false);
  const gridRef = useRef(null);

  const style = GRAPH_STYLES[styleId] || GRAPH_STYLES.constellation;
  const layout = LAYOUTS[layoutId] || LAYOUTS.organic;

  // Props the mount-once interaction effect needs at CALL time, not mount time.
  // Captured plainly, the zoom/pointer handlers keep the FIRST render's onSelect/
  // onExpand/style forever — so double-clicking a node after switching OPC UA
  // servers browsed the wrong (old) server, and style/selection changes didn't
  // repaint on interaction. Refreshed every render, read via cbRef.current.
  const cbRef = useRef({});
  cbRef.current = { onSelect, onExpand, style };

  const colorFor = useCallback(
    (n) => (colorByProtocol && n.protocol ? PROTOCOL_COLORS[n.protocol] || style.palette[0] : groupColor(n.group, style.palette)),
    [colorByProtocol, style]
  );

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

    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, width, height);

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

    // Focus mode: dim everything except the focused node and its neighbors.
    const focusSet = focusId ? new Set([focusId]) : null;
    if (focusSet) {
      for (const l of links) {
        if (l.source.id === focusId) focusSet.add(l.target.id);
        if (l.target.id === focusId) focusSet.add(l.source.id);
      }
    }
    const matching = matchIds && matchIds.size ? matchIds : null;

    const nodeAlpha = (n) => {
      if (focusSet && !focusSet.has(n.id)) return 0.08;
      if (matching && !matching.has(n.id)) return 0.12;
      if (hover && hover.id !== n.id && !neighbors.has(n.id)) return 0.35;
      if (activitySize && n.meta?.isLeaf && (rateRef.current.get(n.id) || 0) < 0.05) return 0.4;
      return 1;
    };

    // Level of detail: above ~220 nodes drop the expensive canvas glow and edge
    // curvature; above ~4000 ("big"/show-all) also cull to the viewport, render
    // sub-pixel nodes as points, and drop links when zoomed far out — so even
    // hundreds of thousands of nodes pan and zoom smoothly.
    const heavy = nodes.length > 220;
    const big = nodes.length > 4000;
    const curve = !heavy;

    // Visible graph-space rect (+margin) for culling.
    const m = 80 / t.k;
    const vx0 = -t.x / t.k - m;
    const vy0 = -t.y / t.k - m;
    const vx1 = (width - t.x) / t.k + m;
    const vy1 = (height - t.y) / t.k + m;
    const inView = (x, y) => x >= vx0 && x <= vx1 && y >= vy0 && y <= vy1;

    // Links: batch the common case into ONE stroke; draw active / faded /
    // composition edges individually. In big mode, cull to the viewport and skip
    // links entirely when zoomed far out (nodes convey structure).
    const drawLinks = !big || t.k >= 0.3;
    if (drawLinks) {
      ctx.lineWidth = style.link.width / t.k;
      ctx.strokeStyle = style.link.color;
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      const special = [];
      for (const l of links) {
        if (big && !inView(l.source.x, l.source.y) && !inView(l.target.x, l.target.y)) continue;
        const active = hover && (l.source.id === hover.id || l.target.id === hover.id);
        const faded = focusSet && !(focusSet.has(l.source.id) && focusSet.has(l.target.id));
        if (active || faded || l.kind === 'composition') {
          special.push({ l, active, faded });
          continue;
        }
        addLinkPath(ctx, l, curve);
      }
      ctx.stroke();
      for (const { l, active, faded } of special) {
        ctx.globalAlpha = faded ? 0.15 : 1;
        ctx.strokeStyle = active ? style.linkHighlight : style.link.color;
        ctx.setLineDash(l.kind === 'composition' ? [5 / t.k, 4 / t.k] : []);
        ctx.beginPath();
        addLinkPath(ctx, l, curve);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    const showLabels = t.k >= style.showLabelsAtZoom;
    const showValues = nodeValues && t.k >= valueZoom;

    for (const n of nodes) {
      if (big && !inView(n.x, n.y)) continue;
      const baseR = nodeRadius(n, style);
      const rate = rateRef.current.get(n.id) || 0;
      const r = activitySize ? baseR * (1 + Math.min(rate, 6) * 0.18) : baseR;
      const color = colorFor(n);
      const alpha = nodeAlpha(n);

      // Fast path for tiny on-screen nodes in big graphs: a cheap point, no
      // arc / stroke / glow / label.
      if (big && r * t.k < 1.4) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        const s = 1.6 / t.k;
        ctx.fillRect(n.x - s / 2, n.y - s / 2, s, s);
        ctx.globalAlpha = 1;
        continue;
      }

      ctx.globalAlpha = alpha;

      let glow = 0;
      if (!heavy) glow = (style.node.glow || 0) + Math.min(rate, 4) * 6;
      if (glow > 0) {
        ctx.shadowColor = color;
        ctx.shadowBlur = glow;
      } else if (ctx.shadowBlur) {
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

      // Collapsed-subtree badge
      if (n.collapsedCount) {
        drawBadge(ctx, n.x + r, n.y - r, `+${n.collapsedCount}`, t.k, style.linkHighlight);
      }

      ctx.globalAlpha = 1;

      if (showLabels && alpha > 0.3) {
        ctx.font = style.labelFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const label = n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label;
        ctx.lineWidth = 3 / t.k;
        ctx.strokeStyle = style.label.halo;
        ctx.strokeText(label, n.x, n.y + r + 2);
        ctx.fillStyle = style.label.color;
        ctx.fillText(label, n.x, n.y + r + 2);

        // Value overlay + sparkline for leaf nodes above the zoom threshold
        if (showValues && alpha > 0.5) {
          const v = nodeValues[n.id];
          if (v) {
            if (v.text != null) {
              ctx.font = `600 11px 'JetBrains Mono', monospace`;
              const vt = String(v.text).slice(0, 18);
              ctx.lineWidth = 3 / t.k;
              ctx.strokeStyle = style.label.halo;
              ctx.strokeText(vt, n.x, n.y + r + 16);
              ctx.fillStyle = style.linkHighlight;
              ctx.fillText(vt, n.x, n.y + r + 16);
            }
            if (v.series && v.series.length > 1) {
              drawSparkline(ctx, v.series, n.x, n.y - r - 4, 34, 12, t.k, style.linkHighlight);
            }
          }
        }
      }
    }

    // Live-flow overlay: expanding pulse rings + travelling dots.
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
      if (!heavy) {
        ctx.shadowColor = style.linkHighlight;
        ctx.shadowBlur = 8;
      }
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

    if (minimap) drawMinimap(ctx, nodes, transformRef.current, sizeRef.current, style, colorFor);
  }, [style, selectedId, activitySize, nodeValues, valueZoom, matchIds, focusId, minimap, colorFor]);

  useEffect(() => {
    drawRef.current = draw;
  }, [draw]);

  // Build / rebuild the simulation when data or layout changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;

    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const nodes = data.nodes.map((n) => {
      const old = prev.get(n.id);
      return old ? { ...n, x: old.x, y: old.y, vx: old.vx, vy: old.vy } : { ...n };
    });
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const links = data.links
      .filter((l) => nodeById.has(l.source) && nodeById.has(l.target))
      .map((l) => ({ source: l.source, target: l.target, kind: l.kind }));

    const parentOf = new Map();
    for (const l of links) parentOf.set(l.target, l.source);
    nodeByIdRef.current = nodeById;
    parentOfRef.current = parentOf;
    nodesRef.current = nodes;
    linksRef.current = links;
    layoutModeRef.current = layout.mode;

    if (simRef.current) simRef.current.stop();

    const depth = computeDepths(nodes, links);

    // Big / show-all graphs: skip physics entirely — a force sim on tens of
    // thousands of nodes is infeasible. Place nodes with a deterministic radial
    // tree (O(n)), build a spatial grid for hit-testing, and rely on viewport
    // culling in draw(). Pan/zoom stay smooth; node dragging is disabled.
    const big = nodes.length > 4000;
    bigRef.current = big;
    if (big) {
      radialTreeLayout(nodes, links, depth);
      buildGrid(nodes, gridRef);
      simRef.current = null;
      requestAnimationFrame(() => draw());
      return undefined;
    }

    const sim = forceSimulation(nodes)
      .force('link', forceLink(links).id((d) => d.id).distance(layout.linkDistance || 55).strength(0.6))
      .force('collide', forceCollide().radius((d) => nodeRadius(d, style) + 4))
      .alpha(0.9)
      .alphaDecay(0.028)
      .on('tick', draw);

    if (layout.mode === 'radial') {
      sim
        .force('charge', forceManyBody().strength(layout.charge))
        .force('radial', forceRadial((d) => (depth.get(d.id) || 0) * layout.ringGap, 0, 0).strength(0.9))
        .force('center', forceCenter(0, 0).strength(0.05));
    } else if (layout.mode === 'cluster') {
      const centers = clusterCenters(nodes, layout.clusterRadius);
      sim
        .force('charge', forceManyBody().strength(layout.charge))
        .force('x', forceX((d) => centers.get(d.group)?.x || 0).strength(0.25))
        .force('y', forceY((d) => centers.get(d.group)?.y || 0).strength(0.25));
    } else if (layout.mode === 'tree') {
      const pos = treePositions(nodes, links, layout);
      for (const n of nodes) {
        const p = pos.get(n.id);
        if (p) {
          n.x = p.x;
          n.y = p.y;
          n.fx = p.x;
          n.fy = p.y;
        }
      }
      sim.alphaDecay(0.2); // settle immediately — positions are fixed
    } else {
      sim
        .force('charge', forceManyBody().strength(layout.charge))
        .force('center', forceCenter(0, 0))
        .force('x', forceX(0).strength(layout.gravity))
        .force('y', forceY(0).strength(layout.gravity));
    }

    simRef.current = sim;
    return () => sim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, layout, draw]);

  useEffect(() => {
    draw();
  }, [draw]);

  // ---- Live message-flow animation ----
  const startAnimation = useCallback(() => {
    if (rafRef.current) return;
    lastFrameRef.current = 0;
    const step = (ts) => {
      const dt = lastFrameRef.current ? Math.min(ts - lastFrameRef.current, 50) : 16;
      lastFrameRef.current = ts;

      const particles = particlesRef.current;
      for (let i = particles.length - 1; i >= 0; i--) {
        particles[i].progress += dt * particles[i].speed;
        if (particles[i].progress >= 1) particles.splice(i, 1);
      }
      const pulseDecay = Math.pow(0.9, dt / 16);
      for (const [id, s] of pulseRef.current) {
        const next = s * pulseDecay;
        if (next < 0.04) pulseRef.current.delete(id);
        else pulseRef.current.set(id, next);
      }
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

  // Register activity on a node: bump its rate, and (when animating) pulse it and
  // send a dot from the root down to it. `force` animates regardless of the flow
  // toggle — used by the replay scrubber.
  const emitPulse = useCallback(
    (nodeId, force) => {
      const byId = nodeByIdRef.current;
      if (!byId.has(nodeId)) return;

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
      path.reverse();

      rateRef.current.set(nodeId, (rateRef.current.get(nodeId) || 0) + 1);
      if (flow || force) {
        pulseRef.current.set(nodeId, 1);
        if (path.length >= 2) {
          const dur = 450 + (path.length - 1) * 130;
          particlesRef.current.push({ nodeIds: path, progress: 0, speed: 1 / dur });
          if (particlesRef.current.length > 200) particlesRef.current.shift();
        }
      }
      startAnimation();
    },
    [flow, startAnimation]
  );
  const pulse = useCallback((nodeId) => emitPulse(nodeId, false), [emitPulse]);

  // Subscribe to the activity bus whenever flow OR activity-sizing needs it.
  useEffect(() => {
    if ((!flow && !activitySize) || !activitySource) return undefined;
    const unsub = activitySource(pulse);
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [flow, activitySize, activitySource, pulse]);

  // Clear transient animation state when both live features are off.
  useEffect(() => {
    if (flow || activitySize) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    particlesRef.current = [];
    pulseRef.current.clear();
    rateRef.current.clear();
    draw();
  }, [flow, activitySize, draw]);

  useEffect(() => () => rafRef.current && cancelAnimationFrame(rafRef.current), []);

  // ---- Imperative handle: fit-to and export ----
  const fitTo = useCallback((ids) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h } = sizeRef.current;
    const set = ids && ids.size ? ids : null;
    const nodes = nodesRef.current.filter((n) => (set ? set.has(n.id) : true));
    if (!nodes.length || w === 0) return;
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const pad = 90;
    const k = Math.min((w - pad) / Math.max(maxX - minX, 1), (h - pad) / Math.max(maxY - minY, 1), 2.5);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const t = zoomIdentity.translate(w / 2 - k * cx, h / 2 - k * cy).scale(k);
    if (selRef.current && zoomRef.current) selRef.current.call(zoomRef.current.transform, t);
    transformRef.current = t;
    draw();
  }, [draw]);

  useImperativeHandle(
    ref,
    () => ({
      fitTo,
      pulseNode: (nodeId) => emitPulse(nodeId, true),
      exportPng: () => canvasRef.current?.toDataURL('image/png'),
      exportGraph: () => ({
        nodes: (data?.nodes || []).map(({ id, label, group, kind }) => ({ id, label, group, kind })),
        links: (data?.links || []).map((l) => ({ source: l.source, target: l.target, kind: l.kind }))
      })
    }),
    [fitTo, emitPulse, data]
  );

  // ---- Canvas sizing + interaction wiring (once) ----
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const sel = select(canvas);
    selRef.current = sel;

    const zoomBehavior = zoom()
      .scaleExtent([0.05, 8])
      .on('zoom', (event) => {
        transformRef.current = event.transform;
        drawRef.current();
      });
    zoomRef.current = zoomBehavior;
    sel.call(zoomBehavior);

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      const { width, height } = wrap.getBoundingClientRect();
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      sizeRef.current = { w: width, h: height };
      if (!centeredRef.current && width > 0 && height > 0) {
        centeredRef.current = true;
        const initial = zoomIdentity.translate(width / 2, height / 2);
        transformRef.current = initial;
        sel.call(zoomBehavior.transform, initial);
      }
      drawRef.current();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const toGraphCoords = (event) => {
      const rect = canvas.getBoundingClientRect();
      const t = transformRef.current;
      return { x: (event.clientX - rect.left - t.x) / t.k, y: (event.clientY - rect.top - t.y) / t.k };
    };

    const pick = (gx, gy) => {
      const curStyle = cbRef.current.style;
      // Big graphs use the spatial grid; smaller ones scan linearly.
      if (bigRef.current && gridRef.current) return pickFromGrid(gx, gy, gridRef.current, curStyle);
      const nodes = nodesRef.current;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const r = nodeRadius(n, curStyle) + 6;
        if ((n.x - gx) ** 2 + (n.y - gy) ** 2 <= r * r) return n;
      }
      return null;
    };

    const dragBehavior = drag()
      .container(canvas)
      .subject((event) => {
        if (bigRef.current) return null; // pan/zoom only in big mode
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
        // Keep nodes pinned in tree mode; release them in free-form layouts.
        if (layoutModeRef.current !== 'tree') {
          event.subject.fx = null;
          event.subject.fy = null;
        }
      });
    sel.call(dragBehavior);

    let downPos = null;
    const onDown = (e) => {
      downPos = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e) => {
      if (!downPos) return;
      const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
      downPos = null;
      if (moved > 5) return;
      const { x, y } = toGraphCoords(e);
      const hit = pick(x, y);
      if (hit && cbRef.current.onSelect) cbRef.current.onSelect(hit);
    };
    const onDblClick = (e) => {
      const { x, y } = toGraphCoords(e);
      const hit = pick(x, y);
      if (hit && cbRef.current.onExpand) cbRef.current.onExpand(hit);
    };
    const onMove = (e) => {
      const { x, y } = toGraphCoords(e);
      const hit = pick(x, y);
      if (hit !== hoverRef.current) {
        hoverRef.current = hit;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
        drawRef.current();
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
});

export default ForceGraph;

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
function nodeRadius(n, style) {
  const base = style.nodeMinRadius;
  const scaled = base + Math.sqrt(n.degree || 0) * 3;
  if (n.kind === 'broker' || n.kind === 'opcua-server' || n.kind === 'i3x-server') return style.nodeMaxRadius;
  return Math.min(scaled, style.nodeMaxRadius);
}

// Add one link's path (straight, or a gentle perpendicular-offset curve) to the
// current path so many links can be batched into a single stroke.
function addLinkPath(ctx, l, curve) {
  const x1 = l.source.x;
  const y1 = l.source.y;
  const x2 = l.target.x;
  const y2 = l.target.y;
  ctx.moveTo(x1, y1);
  if (!curve) {
    ctx.lineTo(x2, y2);
    return;
  }
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  ctx.quadraticCurveTo(mx - dy * 0.12, my + dx * 0.12, x2, y2);
}

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

function drawBadge(ctx, x, y, text, k, color) {
  ctx.save();
  ctx.font = `600 ${10 / k}px Inter, sans-serif`;
  const padX = 4 / k;
  const w = ctx.measureText(text).width + padX * 2;
  const h = 13 / k;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  roundRect(ctx, x - w / 2, y - h / 2, w, h, 4 / k);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0a0f1c';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawSparkline(ctx, series, cx, cy, w, h, k, color) {
  const vals = series.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const sw = w / k;
  const sh = h / k;
  const x0 = cx - sw / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2 / k;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  vals.forEach((v, i) => {
    const px = x0 + (i / (vals.length - 1)) * sw;
    const py = cy - ((v - min) / span) * sh;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawMinimap(ctx, nodes, t, size, style, colorFor) {
  if (!nodes.length || size.w === 0) return;
  const mw = 168;
  const mh = 112;
  const mx = size.w - mw - 16;
  const my = size.h - mh - 16;

  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const gw = Math.max(maxX - minX, 1);
  const gh = Math.max(maxY - minY, 1);
  const pad = 8;
  const s = Math.min((mw - pad * 2) / gw, (mh - pad * 2) / gh);
  const toMx = (x) => mx + pad + (x - minX) * s;
  const toMy = (y) => my + pad + (y - minY) * s;

  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = 'rgba(10,15,28,0.85)';
  roundRect(ctx, mx, my, mw, mh, 10);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.clip();

  for (const n of nodes) {
    ctx.fillStyle = colorFor(n);
    ctx.beginPath();
    ctx.arc(toMx(n.x), toMy(n.y), 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Viewport rectangle: which graph area is currently visible
  const vx0 = (-t.x) / t.k;
  const vy0 = (-t.y) / t.k;
  const vx1 = (size.w - t.x) / t.k;
  const vy1 = (size.h - t.y) / t.k;
  ctx.strokeStyle = style.linkHighlight;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(toMx(vx0), toMy(vy0), (vx1 - vx0) * s, (vy1 - vy0) * s);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------
function computeDepths(nodes, links) {
  const childrenOf = new Map();
  const hasParent = new Set();
  for (const l of links) {
    if (!childrenOf.has(l.source)) childrenOf.set(l.source, []);
    childrenOf.get(l.source).push(l.target);
    hasParent.add(l.target);
  }
  const depth = new Map();
  const roots = nodes.filter((n) => !hasParent.has(n.id));
  const queue = roots.map((n) => [n.id, 0]);
  for (const n of roots) depth.set(n.id, 0);
  while (queue.length) {
    const [id, d] = queue.shift();
    for (const c of childrenOf.get(id) || []) {
      if (!depth.has(c)) {
        depth.set(c, d + 1);
        queue.push([c, d + 1]);
      }
    }
  }
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0);
  return depth;
}

function treePositions(nodes, links, layout) {
  const childrenOf = new Map();
  const hasParent = new Set();
  for (const l of links) {
    if (!childrenOf.has(l.source)) childrenOf.set(l.source, []);
    childrenOf.get(l.source).push(l.target);
    hasParent.add(l.target);
  }
  const rowGap = layout.rowGap || 90;
  const colGap = layout.colGap || 46;
  const pos = new Map();
  let order = 0;
  const seen = new Set();

  const visit = (id, depth) => {
    if (seen.has(id)) return order * colGap;
    seen.add(id);
    const kids = (childrenOf.get(id) || []).filter((k) => !seen.has(k));
    if (kids.length === 0) {
      const x = order * colGap;
      order++;
      pos.set(id, { x, y: depth * rowGap });
      return x;
    }
    const xs = kids.map((k) => visit(k, depth + 1));
    const x = (Math.min(...xs) + Math.max(...xs)) / 2;
    pos.set(id, { x, y: depth * rowGap });
    return x;
  };

  const roots = nodes.filter((n) => !hasParent.has(n.id));
  for (const r of roots) visit(r.id, 0);
  for (const n of nodes) if (!pos.has(n.id)) visit(n.id, 0); // stragglers

  const xsAll = [...pos.values()].map((p) => p.x);
  const ysAll = [...pos.values()].map((p) => p.y);
  const cx = xsAll.length ? (Math.min(...xsAll) + Math.max(...xsAll)) / 2 : 0;
  const cy = ysAll.length ? (Math.min(...ysAll) + Math.max(...ysAll)) / 2 : 0;
  for (const p of pos.values()) {
    p.x -= cx;
    p.y -= cy;
  }
  return pos;
}

function clusterCenters(nodes, radius) {
  const groups = [...new Set(nodes.map((n) => n.group))];
  const centers = new Map();
  groups.forEach((g, i) => {
    const angle = (i / groups.length) * Math.PI * 2;
    centers.set(g, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  });
  return centers;
}

// Deterministic O(n) radial-tree layout for very large graphs: each node owns an
// angular wedge proportional to its leaf count, placed at radius ∝ depth. No
// physics — positions are exact, so it scales to hundreds of thousands of nodes.
function radialTreeLayout(nodes, links, depth) {
  const childrenOf = new Map();
  const hasParent = new Set();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const l of links) {
    if (!childrenOf.has(l.source)) childrenOf.set(l.source, []);
    childrenOf.get(l.source).push(l.target);
    hasParent.add(l.target);
  }
  const maxDepth = Math.max(1, ...nodes.map((n) => depth.get(n.id) || 0));
  const ring = 260 + maxDepth * 10; // spread rings a bit as the tree deepens

  // Leaf counts drive angular allocation so dense branches get more room.
  const leaves = new Map();
  const countLeaves = (id, guard) => {
    if (leaves.has(id)) return leaves.get(id);
    if (guard.has(id)) return 1;
    guard.add(id);
    const kids = childrenOf.get(id) || [];
    let c = kids.length === 0 ? 1 : 0;
    for (const k of kids) c += countLeaves(k, guard);
    leaves.set(id, c || 1);
    return leaves.get(id);
  };

  const roots = nodes.filter((n) => !hasParent.has(n.id));
  for (const r of roots) countLeaves(r.id, new Set());

  const place = (id, a0, a1, d, guard) => {
    const n = byId.get(id);
    if (!n || guard.has(id)) return;
    guard.add(id);
    const mid = (a0 + a1) / 2;
    const radius = d * ring;
    n.x = Math.cos(mid) * radius;
    n.y = Math.sin(mid) * radius;
    n.fx = n.x;
    n.fy = n.y;
    const kids = childrenOf.get(id) || [];
    if (kids.length === 0) return;
    const total = kids.reduce((s, k) => s + (leaves.get(k) || 1), 0) || 1;
    let a = a0;
    for (const k of kids) {
      const span = ((leaves.get(k) || 1) / total) * (a1 - a0);
      place(k, a, a + span, d + 1, guard);
      a += span;
    }
  };

  const guard = new Set();
  const totalLeaves = roots.reduce((s, r) => s + (leaves.get(r.id) || 1), 0) || 1;
  let a = 0;
  for (const r of roots) {
    const span = ((leaves.get(r.id) || 1) / totalLeaves) * Math.PI * 2;
    place(r.id, a, a + span, 0, guard);
    a += span;
  }
}

// Uniform spatial grid over node positions for O(1)-ish hit-testing at scale.
function buildGrid(nodes, gridRef) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  const cell = 40;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const map = new Map();
  for (const n of nodes) {
    const key = cellKey(n.x, n.y, minX, minY, cell, cols);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(n);
  }
  gridRef.current = { minX, minY, cell, cols, map };
}

function cellKey(x, y, minX, minY, cell, cols) {
  const cx = Math.floor((x - minX) / cell);
  const cy = Math.floor((y - minY) / cell);
  return cy * cols + cx;
}

function pickFromGrid(gx, gy, grid, style) {
  const { minX, minY, cell, cols, map } = grid;
  let best = null;
  let bestD = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const key = cellKey(gx + dx * cell, gy + dy * cell, minX, minY, cell, cols);
      const bucket = map.get(key);
      if (!bucket) continue;
      for (const n of bucket) {
        const r = nodeRadius(n, style) + 6;
        const d = (n.x - gx) ** 2 + (n.y - gy) ** 2;
        if (d <= r * r && d < bestD) {
          best = n;
          bestD = d;
        }
      }
    }
  }
  return best;
}
