import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { GRAPH_STYLES } from './graphStyles';
import { groupColor, PROTOCOL_COLORS } from './buildGraph';

/**
 * 3D node graph rendered on a 2D canvas (no WebGL dependency). Nodes are placed
 * with a deterministic spherical-tree layout, projected with perspective, and
 * orbited with the mouse: drag to rotate around both axes, wheel to zoom. Nodes
 * are depth-sorted and faded so the structure reads clearly from any angle, and
 * you can rotate to reach any node.
 */
const FOCAL = 900;
const CAM_DIST = 950;
const MAX_3D_NODES = 12000; // 3D projection + depth sort per frame stays smooth to here

const ForceGraph3D = forwardRef(function ForceGraph3D(
  { data, styleId = 'constellation', selectedId = null, onSelect, colorByProtocol = false },
  ref
) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const nodesRef = useRef([]);
  const linksRef = useRef([]);
  const byIdRef = useRef(new Map());
  const projRef = useRef([]); // cached screen projections for hit-testing
  const dprRef = useRef(1);
  const sizeRef = useRef({ w: 0, h: 0 });
  const rotRef = useRef({ yaw: 0.6, pitch: -0.35 });
  const zoomRef = useRef(1);
  const hoverRef = useRef(null);
  const drawRef = useRef(() => {});

  const style = GRAPH_STYLES[styleId] || GRAPH_STYLES.constellation;
  const colorFor = useCallback(
    (n) => (colorByProtocol && n.protocol ? PROTOCOL_COLORS[n.protocol] || style.palette[0] : groupColor(n.group, style.palette)),
    [colorByProtocol, style]
  );

  const capped = data && data.nodes.length > MAX_3D_NODES;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = dprRef.current;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, width, height);

    const nodes = nodesRef.current;
    const links = linksRef.current;
    const byId = byIdRef.current;
    const cx = width / 2;
    const cy = height / 2;
    const zoom = zoomRef.current;
    const { yaw, pitch } = rotRef.current;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosX = Math.cos(pitch);
    const sinX = Math.sin(pitch);

    // Project every node into screen space (and cache for hit-testing).
    const proj = new Map();
    for (const n of nodes) {
      const x1 = n.x * cosY + n.z * sinY;
      const z1 = -n.x * sinY + n.z * cosY;
      const y2 = n.y * cosX - z1 * sinX;
      const z2 = n.y * sinX + z1 * cosX;
      const zc = z2 + CAM_DIST;
      if (zc < 1) continue;
      const scale = (FOCAL / zc) * zoom;
      proj.set(n.id, { sx: cx + x1 * scale, sy: cy + y2 * scale, scale, zc });
    }
    projRef.current = [];

    const hover = hoverRef.current;

    // Links first (behind nodes), faded by average depth.
    ctx.lineWidth = 1;
    for (const l of links) {
      const a = proj.get(l.source);
      const b = proj.get(l.target);
      if (!a || !b) continue;
      const active = hover && (l.source === hover || l.target === hover);
      ctx.globalAlpha = active ? 0.9 : 0.18;
      ctx.strokeStyle = active ? style.linkHighlight : style.link.color;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Nodes far→near so nearer ones paint on top.
    const drawList = [];
    for (const n of nodes) {
      const p = proj.get(n.id);
      if (!p) continue;
      drawList.push({ n, p });
    }
    drawList.sort((a, b) => b.p.zc - a.p.zc);

    const showLabels = zoom >= 0.9;
    for (const { n, p } of drawList) {
      const baseR = n.kind === 'broker' || n.kind === 'opcua-server' || n.kind === 'i3x-server' ? 10 : 4 + Math.sqrt(n.degree || 0) * 1.6;
      const r = Math.max(1, baseR * p.scale);
      // Depth cue: fade nodes that are farther from the camera.
      const depthAlpha = Math.max(0.25, Math.min(1, 1.4 - (p.zc - CAM_DIST + 400) / 1400));
      const color = colorFor(n);
      const dim = hover && hover !== n.id;

      projRef.current.push({ id: n.id, sx: p.sx, sy: p.sy, r: r + 4, zc: p.zc });

      ctx.globalAlpha = dim ? depthAlpha * 0.4 : depthAlpha;
      if (style.node.glow && r > 2) {
        ctx.shadowColor = color;
        ctx.shadowBlur = Math.min(16, r * 1.5);
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (n.id === selectedId) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = style.selectedRing;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (showLabels && r > 5 && !dim) {
        ctx.globalAlpha = depthAlpha;
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const label = n.label.length > 20 ? `${n.label.slice(0, 19)}…` : n.label;
        ctx.lineWidth = 3;
        ctx.strokeStyle = style.label.halo;
        ctx.strokeText(label, p.sx, p.sy + r + 2);
        ctx.fillStyle = style.label.color;
        ctx.fillText(label, p.sx, p.sy + r + 2);
      }
    }
    ctx.globalAlpha = 1;
  }, [style, selectedId, colorFor]);

  useEffect(() => {
    drawRef.current = draw;
    draw();
  }, [draw]);

  // Layout when data changes.
  useEffect(() => {
    if (!data) return;
    const nodes = data.nodes.slice(0, MAX_3D_NODES).map((n) => ({ ...n }));
    const keep = new Set(nodes.map((n) => n.id));
    const links = data.links.filter((l) => keep.has(l.source) && keep.has(l.target)).map((l) => ({ ...l }));
    sphericalTreeLayout(nodes, links);
    nodesRef.current = nodes;
    linksRef.current = links;
    byIdRef.current = new Map(nodes.map((n) => [n.id, n]));
    draw();
  }, [data, draw]);

  useImperativeHandle(ref, () => ({
    resetView: () => {
      rotRef.current = { yaw: 0.6, pitch: -0.35 };
      zoomRef.current = 1;
      draw();
    }
  }), [draw]);

  // Canvas sizing + orbit / zoom / pick wiring.
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
      sizeRef.current = { w: width, h: height };
      drawRef.current();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    let dragging = false;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;

    const onDown = (e) => {
      dragging = true;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (e) => {
      if (dragging) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        moved += Math.abs(dx) + Math.abs(dy);
        const rot = rotRef.current;
        rot.yaw += dx * 0.008;
        rot.pitch += dy * 0.008;
        rot.pitch = Math.max(-1.5, Math.min(1.5, rot.pitch));
        drawRef.current();
      } else {
        // hover pick
        const hit = pick(e);
        const id = hit ? hit.id : null;
        if (id !== hoverRef.current) {
          hoverRef.current = id;
          canvas.style.cursor = id ? 'pointer' : 'grab';
          drawRef.current();
        }
      }
    };
    const onUp = (e) => {
      canvas.style.cursor = 'grab';
      if (dragging && moved < 5) {
        const hit = pick(e);
        if (hit && onSelect) {
          const node = byIdRef.current.get(hit.id);
          if (node) onSelect(node);
        }
      }
      dragging = false;
    };
    const onWheel = (e) => {
      e.preventDefault();
      const z = zoomRef.current * (e.deltaY < 0 ? 1.12 : 0.89);
      zoomRef.current = Math.max(0.15, Math.min(6, z));
      drawRef.current();
    };

    const pick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      let best = null;
      let bestZ = Infinity;
      for (const p of projRef.current) {
        const d = (p.sx - mx) ** 2 + (p.sy - my) ** 2;
        if (d <= p.r * p.r && p.zc < bestZ) {
          best = p;
          bestZ = p.zc;
        }
      }
      return best;
    };

    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="graph-canvas" />
      {capped && (
        <div className="pointer-events-none absolute right-4 top-16 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 backdrop-blur">
          3D view showing the first {MAX_3D_NODES.toLocaleString()} nodes — use the 2D graph or tree for the full set.
        </div>
      )}
    </div>
  );
});

export default ForceGraph3D;

// Deterministic 3D spherical-tree layout: nodes fill nested depth shells, each
// owning a solid-angle patch (φ×θ) split among its children — so children sit
// near their parent and the whole structure is legible from any rotation.
function sphericalTreeLayout(nodes, links) {
  const childrenOf = new Map();
  const hasParent = new Set();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const l of links) {
    if (!childrenOf.has(l.source)) childrenOf.set(l.source, []);
    childrenOf.get(l.source).push(l.target);
    hasParent.add(l.target);
  }
  const R = 150;

  const place = (id, phi0, phi1, theta0, theta1, depth, splitPhi, guard) => {
    const n = byId.get(id);
    if (!n || guard.has(id)) return;
    guard.add(id);
    const phi = (phi0 + phi1) / 2;
    const theta = (theta0 + theta1) / 2;
    const radius = depth * R;
    const sinT = Math.sin(theta);
    n.x = radius * sinT * Math.cos(phi);
    n.y = radius * Math.cos(theta);
    n.z = radius * sinT * Math.sin(phi);

    const kids = childrenOf.get(id) || [];
    if (kids.length === 0) return;
    for (let i = 0; i < kids.length; i++) {
      const f0 = i / kids.length;
      const f1 = (i + 1) / kids.length;
      if (splitPhi) {
        place(kids[i], phi0 + (phi1 - phi0) * f0, phi0 + (phi1 - phi0) * f1, theta0, theta1, depth + 1, false, guard);
      } else {
        place(kids[i], phi0, phi1, theta0 + (theta1 - theta0) * f0, theta0 + (theta1 - theta0) * f1, depth + 1, true, guard);
      }
    }
  };

  const roots = nodes.filter((n) => !hasParent.has(n.id));
  const guard = new Set();
  for (let i = 0; i < roots.length; i++) {
    const f0 = i / roots.length;
    const f1 = (i + 1) / roots.length;
    // Root shell starts one level out so the root isn't at the exact origin
    place(roots[i].id, f0 * 2 * Math.PI, f1 * 2 * Math.PI, 0.15, Math.PI - 0.15, 1, true, guard);
  }
  // Place any orphans (cycles) at the origin shell
  for (const n of nodes) {
    if (n.x === undefined) {
      n.x = 0;
      n.y = 0;
      n.z = 0;
    }
  }
}
