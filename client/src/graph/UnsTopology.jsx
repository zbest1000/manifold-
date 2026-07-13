import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onMessageActivity } from '@/store/store';

/**
 * UNS topology renderer — the Unified-Namespace lens on the data fabric.
 *
 * Renders the namespace as an ISA-95-style hierarchy (Namespace → Business
 * Unit → Site → Area → Line → Cell → Node) laid out as a horizontal tidy tree:
 * white badge nodes with a colored ring + level glyph, the node name and its
 * LEVEL caption beneath, "+ / −" expand affordances, and edges that switch to
 * animated dashed green while data is actually flowing through that branch
 * ("publishing"), fading to quiet gray when the branch goes silent.
 *
 * Deliberately its own canvas component (not ForceGraph): the visual language —
 * light dotted paper, badge nodes, marching-ant live edges, tidy tree — is a
 * different product surface from the dark force-directed topic graphs.
 *
 * Liveness is fed straight from the client message-activity bus: every message
 * stamps `lastActive` on all ancestor paths of its topic; a branch is "live"
 * while its newest stamp is under LIVE_WINDOW_MS old. No server round trips.
 */

export const DEFAULT_LEVELS = ['Unified Namespace', 'Business Unit', 'Site', 'Area', 'Line', 'Cell', 'Node'];
const LEVEL_COLORS = ['#2563eb', '#3b82f6', '#16a34a', '#22c55e', '#0d9488', '#64748b', '#94a3b8'];

const LIVE_WINDOW_MS = 10_000; // branch counts as "publishing" this long after a message
const PULSE_MS = 700; // node ring flash right after a message
const ROW_H = 78;
const COL_W = 210;
const R = 21; // node radius

// Shared activity map (`${brokerId}:${path}` -> last-message ts). Written by the
// renderer's activity subscription, readable by the page's detail panel.
export const unsLiveMap = new Map();

export function lastActive(node) {
  return unsLiveMap.get(`${node.brokerId}:${node.path}`) || 0;
}

export function levelName(depth, levels = DEFAULT_LEVELS) {
  return levels[Math.min(depth, levels.length - 1)];
}

export function levelColor(depth) {
  return LEVEL_COLORS[Math.min(depth, LEVEL_COLORS.length - 1)];
}

/** Build the namespace tree for one broker from its flat topic list. */
export function buildUnsTree(broker, topics) {
  const root = {
    id: `uns:${broker.id}`,
    path: '',
    name: broker.name || `${broker.host}:${broker.port}`,
    depth: 0,
    brokerId: broker.id,
    children: new Map(),
    topicCount: 0
  };
  for (const t of topics) {
    if (!t.topic || t.topic.startsWith('$')) continue; // $SYS is broker internals, not namespace
    const segs = t.topic.split('/').filter(Boolean);
    let node = root;
    root.topicCount++;
    let path = '';
    for (let i = 0; i < segs.length; i++) {
      path = i === 0 ? segs[i] : `${path}/${segs[i]}`;
      let child = node.children.get(segs[i]);
      if (!child) {
        child = {
          id: `uns:${broker.id}:${path}`,
          path,
          name: segs[i],
          depth: i + 1,
          brokerId: broker.id,
          children: new Map(),
          topicCount: 0
        };
        node.children.set(segs[i], child);
      }
      child.topicCount++;
      node = child;
    }
  }
  return root;
}

export default function UnsTopology({ roots, levels = DEFAULT_LEVELS, selectedId = null, onSelect }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const transformRef = useRef({ x: 130, y: 60, k: 1 });
  const visibleRef = useRef([]); // laid-out visible nodes for hit-testing
  const rafRef = useRef(0);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  // Expanded paths per broker. Default: namespace + first level open.
  const [expanded, setExpanded] = useState(() => new Set());
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (initialized || !roots.length) return;
    const seed = new Set();
    for (const r of roots) {
      seed.add(`${r.brokerId}:`);
      for (const child of r.children.values()) seed.add(`${child.brokerId}:${child.path}`);
    }
    setExpanded(seed);
    setInitialized(true);
  }, [roots, initialized]);

  // Live activity: stamp every ancestor path of each incoming topic.
  useEffect(
    () =>
      onMessageActivity((msg) => {
        if (!msg?.topic || msg.topic.startsWith('$')) return;
        const now = Date.now();
        unsLiveMap.set(`${msg.brokerId}:`, now);
        const segs = msg.topic.split('/').filter(Boolean);
        let path = '';
        for (let i = 0; i < segs.length; i++) {
          path = i === 0 ? segs[i] : `${path}/${segs[i]}`;
          unsLiveMap.set(`${msg.brokerId}:${path}`, now);
        }
      }),
    []
  );

  // ---- Tidy tree layout over the EXPANDED portion of the forest ----
  const layout = useMemo(() => {
    const nodes = [];
    const edges = [];
    let cursorY = 0;

    const isOpen = (n) => expanded.has(`${n.brokerId}:${n.path}`);

    // Number of leaf rows a node occupies given current expansion.
    const rows = (n) => {
      if (!isOpen(n) || n.children.size === 0) return 1;
      let sum = 0;
      for (const c of n.children.values()) sum += rows(c);
      return Math.max(sum, 1);
    };

    const place = (n, x, top) => {
      const span = rows(n) * ROW_H;
      const y = top + span / 2;
      const laid = { node: n, x, y, open: isOpen(n), hasKids: n.children.size > 0 };
      nodes.push(laid);
      if (isOpen(n)) {
        let childTop = top;
        // Stable, meaningful order: subtree size desc, then name.
        const kids = [...n.children.values()].sort((a, b) => b.topicCount - a.topicCount || a.name.localeCompare(b.name));
        for (const c of kids) {
          const cLaid = place(c, x + COL_W, childTop);
          edges.push({ from: laid, to: cLaid });
          childTop += rows(c) * ROW_H;
        }
      }
      return laid;
    };

    for (const r of roots) {
      place(r, 0, cursorY);
      cursorY += rows(r) * ROW_H + ROW_H; // gap between namespaces
    }
    return { nodes, edges, height: cursorY };
  }, [roots, expanded]);

  useEffect(() => {
    visibleRef.current = layout.nodes;
    // Read-only hook for e2e tests / screenshot tooling: world coordinates of
    // the visible nodes plus the current view transform.
    if (typeof window !== 'undefined') {
      window.__unsLayout = {
        transform: transformRef.current,
        nodes: layout.nodes.map((l) => ({ name: l.node.name, path: l.node.path, x: l.x, y: l.y, open: l.open, hasKids: l.hasKids, depth: l.node.depth }))
      };
    }
  }, [layout]);

  // ---- Drawing ----
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = sizeRef.current;
    const t = transformRef.current;
    const now = Date.now();

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Light "paper" canvas with a dot grid — the UNS look, distinct from the
    // dark force-graph surfaces.
    ctx.fillStyle = '#f6f7f9';
    ctx.fillRect(0, 0, w, h);
    const grid = 24 * t.k;
    if (grid > 7) {
      ctx.fillStyle = '#dce1e8';
      const ox = t.x % grid;
      const oy = t.y % grid;
      for (let gx = ox; gx < w; gx += grid) {
        for (let gy = oy; gy < h; gy += grid) {
          ctx.fillRect(gx - 0.75, gy - 0.75, 1.5, 1.5);
        }
      }
    }

    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    const liveAt = (n) => unsLiveMap.get(`${n.brokerId}:${n.path}`) || 0;
    const dashOffset = -((now / 40) % 24);

    // Edges first: animated dashed green while the child branch is publishing.
    for (const e of layout.edges) {
      const live = now - liveAt(e.to.node) < LIVE_WINDOW_MS;
      const x1 = e.from.x + R + 3;
      const x2 = e.to.x - R - 3;
      const mx = (x1 + x2) / 2;
      ctx.beginPath();
      ctx.moveTo(x1, e.from.y);
      ctx.bezierCurveTo(mx, e.from.y, mx, e.to.y, x2, e.to.y);
      if (live) {
        ctx.strokeStyle = 'rgba(34,197,94,0.75)';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([7, 6]);
        ctx.lineDashOffset = dashOffset;
      } else {
        ctx.strokeStyle = 'rgba(148,163,184,0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Nodes: white badge, level ring, glyph, name + LEVEL caption, +/- affordance.
    for (const l of layout.nodes) {
      const n = l.node;
      const color = levelColor(n.depth);
      const last = liveAt(n);
      const pulsing = now - last < PULSE_MS;
      const live = now - last < LIVE_WINDOW_MS;

      if (pulsing) {
        const p = 1 - (now - last) / PULSE_MS;
        ctx.beginPath();
        ctx.arc(l.x, l.y, R + 4 + 8 * (1 - p), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(34,197,94,${0.5 * p})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(l.x, l.y, R, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(15,23,42,0.10)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 1;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.lineWidth = n.id === selectedRef.current ? 3 : 2;
      ctx.strokeStyle = n.id === selectedRef.current ? '#f59e0b' : color;
      ctx.stroke();

      drawGlyph(ctx, l.x, l.y, n.depth, color);

      // live dot on the badge edge
      if (live) {
        ctx.beginPath();
        ctx.arc(l.x + R * 0.72, l.y - R * 0.72, 3.4, 0, Math.PI * 2);
        ctx.fillStyle = '#22c55e';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      // expand / collapse affordance
      if (l.hasKids) {
        ctx.beginPath();
        ctx.arc(l.x, l.y + R + 1, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(l.x - 3, l.y + R + 1);
        ctx.lineTo(l.x + 3, l.y + R + 1);
        if (!l.open) {
          ctx.moveTo(l.x, l.y + R - 2);
          ctx.lineTo(l.x, l.y + R + 4);
        }
        ctx.stroke();
      }

      // labels
      ctx.textAlign = 'center';
      ctx.fillStyle = '#1e293b';
      ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(truncate(n.name, 22), l.x, l.y + R + 22);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '600 8.5px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(levelName(n.depth, levels).toUpperCase(), l.x, l.y + R + 33);
      if (n.topicCount > 0 && n.children.size > 0) {
        ctx.fillStyle = '#b0b8c4';
        ctx.font = '500 8.5px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(`${n.topicCount.toLocaleString()} topics`, l.x, l.y + R + 43);
      }
    }

    ctx.restore();
  }, [layout, levels]);

  // Animation loop: cheap (bounded visible nodes), drives dashes + pulses + decay.
  useEffect(() => {
    let running = true;
    const tick = () => {
      if (!running) return;
      draw();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [draw]);

  // Sizing + interactions.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = wrap.getBoundingClientRect();
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      sizeRef.current = { w: width, h: height };
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const toWorld = (e) => {
      const rect = canvas.getBoundingClientRect();
      const t = transformRef.current;
      return { x: (e.clientX - rect.left - t.x) / t.k, y: (e.clientY - rect.top - t.y) / t.k };
    };

    const pick = (p) => {
      for (const l of visibleRef.current) {
        const dx = p.x - l.x;
        const dy = p.y - l.y;
        if (dx * dx + dy * dy <= (R + 10) * (R + 10)) return l;
      }
      return null;
    };

    let dragging = false;
    let moved = 0;
    let last = { x: 0, y: 0 };
    const onDown = (e) => {
      dragging = true;
      moved = 0;
      last = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      last = { x: e.clientX, y: e.clientY };
      transformRef.current.x += dx;
      transformRef.current.y += dy;
    };
    const onUp = (e) => {
      const wasDrag = moved >= 6;
      dragging = false;
      if (wasDrag) return;
      const p = toWorld(e);
      const hit = pick(p);
      if (!hit) return;
      // Click near the +/- affordance (below the badge) toggles expansion.
      const nearToggle = hit.hasKids && p.y > hit.y + R - 6 && Math.abs(p.x - hit.x) < 12;
      if (nearToggle) toggle(hit.node);
      else onSelect?.(hit.node);
    };
    const onDbl = (e) => {
      const hit = pick(toWorld(e));
      if (hit?.hasKids) toggle(hit.node);
    };
    const onWheel = (e) => {
      e.preventDefault();
      const t = transformRef.current;
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const nk = Math.max(0.2, Math.min(3, t.k * factor));
      t.x = px - ((px - t.x) * nk) / t.k;
      t.y = py - ((py - t.y) * nk) / t.k;
      t.k = nk;
    };

    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('dblclick', onDbl);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('wheel', onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSelect]);

  const toggle = (node) => {
    const key = `${node.brokerId}:${node.path}`;
    // Collapsing also collapses everything beneath, so re-expanding is tidy.
    const descendantPrefix = node.path === '' ? `${node.brokerId}:` : `${node.brokerId}:${node.path}/`;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        for (const k of [...next]) {
          if (k !== key && k.startsWith(descendantPrefix)) next.delete(k);
        }
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="h-full w-full cursor-grab active:cursor-grabbing" />
    </div>
  );
}

// Small geometric glyphs per hierarchy level, drawn directly on canvas.
function drawGlyph(ctx, x, y, depth, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.6;
  const d = Math.min(depth, 6);
  if (d === 0) {
    // org chart: one box above two boxes
    ctx.strokeRect(x - 3.5, y - 8, 7, 5.5);
    ctx.strokeRect(x - 9.5, y + 2.5, 7, 5.5);
    ctx.strokeRect(x + 2.5, y + 2.5, 7, 5.5);
    ctx.beginPath();
    ctx.moveTo(x, y - 2.5);
    ctx.lineTo(x, y + 0.5);
    ctx.moveTo(x - 6, y + 0.5);
    ctx.lineTo(x + 6, y + 0.5);
    ctx.moveTo(x - 6, y + 0.5);
    ctx.lineTo(x - 6, y + 2.5);
    ctx.moveTo(x + 6, y + 0.5);
    ctx.lineTo(x + 6, y + 2.5);
    ctx.stroke();
  } else if (d === 1) {
    // cluster of three rings
    for (const [cx, cy] of [[0, -4.5], [-4.5, 3], [4.5, 3]]) {
      ctx.beginPath();
      ctx.arc(x + cx, y + cy, 3.4, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (d === 2) {
    // factory: base + sawtooth roof + chimney
    ctx.beginPath();
    ctx.moveTo(x - 8, y + 7);
    ctx.lineTo(x - 8, y - 1);
    ctx.lineTo(x - 3, y - 5);
    ctx.lineTo(x - 3, y - 1);
    ctx.lineTo(x + 2, y - 5);
    ctx.lineTo(x + 2, y - 1);
    ctx.lineTo(x + 8, y - 1);
    ctx.lineTo(x + 8, y + 7);
    ctx.closePath();
    ctx.stroke();
    ctx.strokeRect(x + 4, y - 8, 2.6, 5);
  } else if (d === 3) {
    // 2x2 grid
    for (const [gx, gy] of [[-6.5, -6.5], [1.5, -6.5], [-6.5, 1.5], [1.5, 1.5]]) {
      ctx.strokeRect(x + gx, y + gy, 5, 5);
    }
  } else if (d === 4) {
    // production line: three bars
    for (let i = -1; i <= 1; i++) ctx.strokeRect(x - 7, y + i * 5 - 1.5, 14, 3);
  } else if (d === 5) {
    ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
  } else {
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
