import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onMessageActivity } from '@/store/store';
import { resolveIconName, getIconImage, loadIcons } from './unsIcons';

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
// Row height covers the badge PLUS its three-line label block so neighboring
// labels can never collide vertically.
const ROW_H = 96;
const COL_W = 224;
const R = 21; // node radius

// Shared activity map (`${brokerId}:${path}` -> last-message ts). Written by the
// renderer's activity subscription, readable by the page's detail panel.
export const unsLiveMap = new Map();
// Latest decoded value per LEAF topic path (`${brokerId}:${path}` -> { value, ts }).
export const unsValueMap = new Map();
// Rolling msgs/s per path, aggregated up the ancestor chain; rolled once a second.
export const unsRateMap = new Map();
const rateCounters = new Map();
// Inter-arrival EMA per leaf topic — the basis for honest staleness: a topic
// that publishes every 500ms is "overdue" seconds after it stops; a daily
// report topic isn't stale for hours.
const gapStats = new Map(); // key -> { emaGap, lastTs }
// Last time ANY message hit the namespace — the idle-throttle signal for the
// draw loop (a quiet namespace has nothing animating, so 60fps is waste).
let lastDataAt = 0;

export function lastActive(node) {
  return unsLiveMap.get(`${node.brokerId}:${node.path}`) || 0;
}

export function nodeValue(node) {
  return unsValueMap.get(`${node.brokerId}:${node.path}`) || null;
}

export function nodeRate(node) {
  return unsRateMap.get(`${node.brokerId}:${node.path}`) || 0;
}

/**
 * Staleness verdict for a leaf topic: null (not enough data yet), 'fresh',
 * 'overdue' (3× its own typical interval, min 15s), or 'dead' (10×, min 2min).
 */
export function staleness(node) {
  const s = gapStats.get(`${node.brokerId}:${node.path}`);
  if (!s || !s.emaGap) return null;
  const age = Date.now() - s.lastTs;
  if (age > Math.max(s.emaGap * 10, 120_000)) return 'dead';
  if (age > Math.max(s.emaGap * 3, 15_000)) return 'overdue';
  return 'fresh';
}

export function expectedInterval(node) {
  const s = gapStats.get(`${node.brokerId}:${node.path}`);
  return s?.emaGap || 0;
}

function formatValue(payload) {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'object') {
    try {
      return JSON.stringify(payload);
    } catch {
      return '[object]';
    }
  }
  return String(payload);
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

export default function UnsTopology({ roots, levels = DEFAULT_LEVELS, selectedId = null, onSelect, focusTarget = null }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const transformRef = useRef({ x: 130, y: 60, k: 1 });
  const visibleRef = useRef([]); // laid-out visible nodes for hit-testing
  // Manual drag offsets on top of the computed layout, keyed `${brokerId}:${path}`.
  // They survive expand/collapse relayouts; "Auto arrange" clears them.
  const manualRef = useRef(new Map());
  // Set once the user takes control of the camera (pan / zoom / drag / toggle).
  // Until then the view auto-frames the whole forest as it loads and grows.
  const userMovedRef = useRef(false);
  // Multi-select: node keys (`${brokerId}:${path}`) the user has box- or
  // ctrl-selected. Dragging any one moves the whole group. Kept in a ref (the
  // draw loop reads it every frame); selCount mirrors its size for the hint.
  const selRef = useRef(new Set());
  const boxRef = useRef(null); // active rubber-band box, world coords {x1,y1,x2,y2}
  const [selCount, setSelCount] = useState(0);
  const rafRef = useRef(0);
  const interactAt = useRef(0); // last pan/zoom/hover — keeps interaction at full fps
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  // Final position of a laid node = tidy-layout position + any manual offset.
  const posOf = useCallback((l) => {
    const off = manualRef.current.get(`${l.node.brokerId}:${l.node.path}`);
    return off ? { x: l.x + off.dx, y: l.y + off.dy } : { x: l.x, y: l.y };
  }, []);

  // Fit the whole visible arrangement (including label blocks) into the viewport.
  const fitAll = useCallback(() => {
    const nodes = visibleRef.current;
    const { w, h } = sizeRef.current;
    if (!nodes.length || !w) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const l of nodes) {
      const p = posOf(l);
      minX = Math.min(minX, p.x - 70);
      maxX = Math.max(maxX, p.x + 70);
      minY = Math.min(minY, p.y - R - 10);
      maxY = Math.max(maxY, p.y + R + 50); // label block below the badge
    }
    const k = Math.max(0.2, Math.min(1.4, Math.min((w - 60) / Math.max(maxX - minX, 1), (h - 60) / Math.max(maxY - minY, 1))));
    // Mutate in place: other closures (zoom/pan, the e2e hook) hold this object.
    const t = transformRef.current;
    t.k = k;
    t.x = w / 2 - (k * (minX + maxX)) / 2;
    t.y = h / 2 - (k * (minY + maxY)) / 2;
  }, [posOf]);

  // Auto arrange: drop every manual offset and re-frame the tidy layout.
  const autoArrange = useCallback(() => {
    manualRef.current.clear();
    fitAll();
  }, [fitAll]);

  // Center the viewport on one laid node at a readable zoom — the target of a
  // "jump to this node" from the lint / events panels.
  const centerOn = useCallback(
    (l) => {
      const { w, h } = sizeRef.current;
      if (!w) return;
      const p = posOf(l);
      const t = transformRef.current;
      t.k = Math.min(1.4, Math.max(t.k, 0.8)); // never focus while zoomed way out
      t.x = w / 2 - t.k * p.x;
      t.y = h / 2 - t.k * p.y;
    },
    [posOf]
  );
  // A pending "focus this node" request, applied once the node is laid out.
  const focusPendingRef = useRef(null);

  // Expanded paths per broker. Default: namespace + first level open. Seeding is
  // per-broker (not one-shot): a broker whose topics stream in AFTER first paint
  // still gets auto-expanded, instead of loading collapsed while its siblings
  // are open. User collapses of already-seeded brokers are preserved.
  const [expanded, setExpanded] = useState(() => new Set());
  const seededRef = useRef(new Set());
  useEffect(() => {
    const fresh = roots.filter((r) => !seededRef.current.has(r.brokerId));
    if (!fresh.length) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const r of fresh) {
        seededRef.current.add(r.brokerId);
        next.add(`${r.brokerId}:`);
        for (const child of r.children.values()) next.add(`${child.brokerId}:${child.path}`);
      }
      return next;
    });
  }, [roots]);

  // Warm the icon set (lazy chunk) so badges upgrade from glyphs to icons.
  useEffect(() => {
    loadIcons();
  }, []);

  // Focus request (from a lint finding / event click): open every ancestor so
  // the node is on-screen, then queue a center-on that the layout effect applies
  // once the node has a laid-out position.
  useEffect(() => {
    if (!focusTarget?.brokerId || focusTarget.path == null) return;
    const { brokerId, path } = focusTarget;
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(`${brokerId}:`);
      const segs = String(path).split('/').filter(Boolean);
      let acc = '';
      // Open ancestors only — the node itself need not be expanded to be visible.
      for (let i = 0; i < segs.length - 1; i++) {
        acc = i === 0 ? segs[i] : `${acc}/${segs[i]}`;
        next.add(`${brokerId}:${acc}`);
      }
      return next;
    });
    focusPendingRef.current = { brokerId, path: String(path) };
    userMovedRef.current = true; // a deliberate jump — auto-fit must not override it
  }, [focusTarget]);

  // Live activity: stamp every ancestor path of each incoming topic, count it
  // for per-branch rates, and record the leaf's value + inter-arrival EMA.
  useEffect(() => {
    const off = onMessageActivity((msg) => {
      if (!msg?.topic || msg.topic.startsWith('$')) return;
      const now = Date.now();
      lastDataAt = now;
      const rootKey = `${msg.brokerId}:`;
      unsLiveMap.set(rootKey, now);
      rateCounters.set(rootKey, (rateCounters.get(rootKey) || 0) + 1);
      const segs = msg.topic.split('/').filter(Boolean);
      let path = '';
      for (let i = 0; i < segs.length; i++) {
        path = i === 0 ? segs[i] : `${path}/${segs[i]}`;
        const key = `${msg.brokerId}:${path}`;
        unsLiveMap.set(key, now);
        rateCounters.set(key, (rateCounters.get(key) || 0) + 1);
      }
      // Leaf bookkeeping: latest value + typical publish interval.
      const leafKey = `${msg.brokerId}:${path}`;
      unsValueMap.set(leafKey, { value: formatValue(msg.payload), ts: now });
      const s = gapStats.get(leafKey);
      if (s) {
        const gap = now - s.lastTs;
        // Ignore sub-5ms bursts (coalesced batch replay) for the interval model.
        if (gap > 5) s.emaGap = s.emaGap ? 0.3 * gap + 0.7 * s.emaGap : gap;
        s.lastTs = now;
      } else {
        gapStats.set(leafKey, { emaGap: 0, lastTs: now });
      }
    });
    // Roll counters into rates once a second.
    const roller = setInterval(() => {
      unsRateMap.clear();
      for (const [key, count] of rateCounters) unsRateMap.set(key, count);
      rateCounters.clear();
    }, 1000);
    return () => {
      off?.();
      clearInterval(roller);
    };
  }, []);

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
    // Auto-frame the whole forest on load AND as it grows — brokers connect,
    // topics stream in, async mount roots arrive — until the user takes control
    // of the camera. A one-shot fit locks onto the first partial forest and
    // leaves all later growth off-center (the reported "doesn't center on
    // load"); re-fitting until interaction keeps it centered without ever
    // fighting manual navigation.
    if (!userMovedRef.current && layout.nodes.length > 0 && sizeRef.current.w > 0) {
      fitAll();
    }
    // Apply a queued focus once its node has a position (it may take an extra
    // layout pass for the just-expanded ancestors to lay the node out).
    if (focusPendingRef.current) {
      const { brokerId, path } = focusPendingRef.current;
      const target = layout.nodes.find((l) => l.node.brokerId === brokerId && l.node.path === path);
      if (target) {
        centerOn(target);
        focusPendingRef.current = null;
      }
    }
    // Read-only hook for e2e tests / screenshot tooling: world coordinates of
    // the visible nodes (manual offsets applied) plus the current view transform.
    if (typeof window !== 'undefined') {
      window.__unsLayout = {
        get transform() {
          return { ...transformRef.current };
        },
        nodes: layout.nodes.map((l) => {
          const p = posOf(l);
          return { name: l.node.name, path: l.node.path, x: p.x, y: p.y, open: l.open, hasKids: l.hasKids, depth: l.node.depth };
        })
      };
    }
  }, [layout, fitAll, posOf, centerOn]);

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
      const a = posOf(e.from);
      const b = posOf(e.to);
      const x1 = a.x + R + 3;
      const x2 = b.x - R - 3;
      const mx = (x1 + x2) / 2;
      ctx.beginPath();
      ctx.moveTo(x1, a.y);
      ctx.bezierCurveTo(mx, a.y, mx, b.y, x2, b.y);
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
      const P = posOf(l);
      const color = levelColor(n.depth);
      const last = liveAt(n);
      const pulsing = now - last < PULSE_MS;
      const live = now - last < LIVE_WINDOW_MS;

      // Multi-select highlight: an accent ring + soft halo on every group member.
      if (selRef.current.has(`${n.brokerId}:${n.path}`)) {
        ctx.beginPath();
        ctx.arc(P.x, P.y, R + 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(56,189,248,0.12)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(56,189,248,0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (pulsing) {
        const p = 1 - (now - last) / PULSE_MS;
        ctx.beginPath();
        ctx.arc(P.x, P.y, R + 4 + 8 * (1 - p), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(34,197,94,${0.5 * p})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(P.x, P.y, R, 0, Math.PI * 2);
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

      // Lucide icon when rasterized; geometric glyph until then (or if unknown).
      const iconImg = getIconImage(resolveIconName(n), color, 40);
      if (iconImg && iconImg.complete && iconImg.naturalWidth > 0) {
        ctx.drawImage(iconImg, P.x - 11, P.y - 11, 22, 22);
      } else {
        drawGlyph(ctx, P.x, P.y, n.depth, color);
      }

      // Status dot on the badge edge: green = publishing now; amber = overdue
      // (silent 3× its typical interval); red = dead (10×). Staleness only
      // applies to leaves — they own a publish cadence; branches just aggregate.
      const stale = n.children.size === 0 ? staleness(n) : null;
      const dotColor = live ? '#22c55e' : stale === 'dead' ? '#ef4444' : stale === 'overdue' ? '#f59e0b' : null;
      if (dotColor) {
        ctx.beginPath();
        ctx.arc(P.x + R * 0.72, P.y - R * 0.72, 3.4, 0, Math.PI * 2);
        ctx.fillStyle = dotColor;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      // expand / collapse affordance
      if (l.hasKids) {
        ctx.beginPath();
        ctx.arc(P.x, P.y + R + 1, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(P.x - 3, P.y + R + 1);
        ctx.lineTo(P.x + 3, P.y + R + 1);
        if (!l.open) {
          ctx.moveTo(P.x, P.y + R - 2);
          ctx.lineTo(P.x, P.y + R + 4);
        }
        ctx.stroke();
      }

      // labels
      // Labels get a paper-colored halo so crossing edges never block the text.
      ctx.textAlign = 'center';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#f6f7f9';
      ctx.lineWidth = 4;
      ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
      ctx.strokeText(truncate(n.name, 22), P.x, P.y + R + 22);
      ctx.fillStyle = '#1e293b';
      ctx.fillText(truncate(n.name, 22), P.x, P.y + R + 22);
      ctx.font = '600 8.5px ui-sans-serif, system-ui, sans-serif';
      ctx.strokeText(levelName(n.depth, levels).toUpperCase(), P.x, P.y + R + 33);
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(levelName(n.depth, levels).toUpperCase(), P.x, P.y + R + 33);
      if (n.children.size > 0) {
        // Branch third line: subtree size, plus live throughput when flowing.
        if (n.topicCount > 0) {
          const rate = unsRateMap.get(`${n.brokerId}:${n.path}`) || 0;
          const line = rate > 0 ? `${n.topicCount.toLocaleString()} topics · ${rate.toLocaleString()}/s` : `${n.topicCount.toLocaleString()} topics`;
          ctx.font = '500 8.5px ui-sans-serif, system-ui, sans-serif';
          ctx.strokeText(line, P.x, P.y + R + 43);
          ctx.fillStyle = rate > 0 ? '#16a34a' : '#b0b8c4';
          ctx.fillText(line, P.x, P.y + R + 43);
        }
      } else {
        // Leaf third line: the topic's latest VALUE — the namespace becomes a
        // live dashboard, not just a map.
        const v = unsValueMap.get(`${n.brokerId}:${n.path}`);
        if (v && v.value !== '') {
          const text = truncate(v.value, 24);
          ctx.font = '600 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.strokeText(text, P.x, P.y + R + 44);
          ctx.fillStyle = stale === 'dead' ? '#ef4444' : stale === 'overdue' ? '#b45309' : '#0f766e';
          ctx.fillText(text, P.x, P.y + R + 44);
        }
      }
    }

    // Rubber-band selection box (drawn in world space; hairline at any zoom).
    if (boxRef.current) {
      const b = boxRef.current;
      const x = Math.min(b.x1, b.x2);
      const y = Math.min(b.y1, b.y2);
      const bw = Math.abs(b.x2 - b.x1);
      const bh = Math.abs(b.y2 - b.y1);
      ctx.fillStyle = 'rgba(56,189,248,0.08)';
      ctx.fillRect(x, y, bw, bh);
      ctx.strokeStyle = 'rgba(56,189,248,0.6)';
      ctx.lineWidth = 1 / t.k;
      ctx.setLineDash([4 / t.k, 3 / t.k]);
      ctx.strokeRect(x, y, bw, bh);
      ctx.setLineDash([]);
    }

    ctx.restore();
  }, [layout, levels, posOf]);

  // Animation loop: cheap (bounded visible nodes), drives dashes + pulses + decay.
  // Idle throttle: pulses/dashes only animate around live traffic and
  // interaction; a quiet view redraws at ~8fps instead of burning 60.
  useEffect(() => {
    let running = true;
    let lastDraw = 0;
    const tick = (ts) => {
      if (!running) return;
      const now = Date.now();
      const active = now - lastDataAt < 3000 || now - interactAt.current < 1000;
      if (active || ts - lastDraw >= 125) {
        lastDraw = ts;
        draw();
      }
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

    const pick = (pt) => {
      for (const l of visibleRef.current) {
        const P = posOf(l);
        const dx = pt.x - P.x;
        const dy = pt.y - P.y;
        if (dx * dx + dy * dy <= (R + 10) * (R + 10)) return l;
      }
      return null;
    };

    // Drag on a node moves THAT node (manual rearrangement); drag on empty
    // canvas pans the view. Click = select, click on ± (or double-click) =
    // expand/collapse. "Auto arrange" clears all manual moves.
    let mode = null; // 'pan' | 'node' | 'box'
    let grabbed = null; // laid node being moved
    let moved = 0;
    let last = { x: 0, y: 0 };
    let ctrlToggled = false; // a ctrl/⌘-click that toggled selection — onUp skips select
    const keyOf = (l) => `${l.node.brokerId}:${l.node.path}`;
    const onDown = (e) => {
      interactAt.current = Date.now();
      moved = 0;
      ctrlToggled = false;
      last = { x: e.clientX, y: e.clientY };
      grabbed = pick(toWorld(e));
      if (grabbed && (e.ctrlKey || e.metaKey)) {
        // Ctrl/⌘-click toggles this node in the multi-selection (no move).
        const key = keyOf(grabbed);
        if (selRef.current.has(key)) selRef.current.delete(key);
        else selRef.current.add(key);
        setSelCount(selRef.current.size);
        ctrlToggled = true;
        grabbed = null;
        mode = null;
        return;
      }
      if (grabbed) {
        mode = 'node';
      } else if (e.shiftKey) {
        // Shift-drag on empty canvas draws a rubber-band selection box.
        const p = toWorld(e);
        boxRef.current = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
        mode = 'box';
      } else {
        mode = 'pan';
      }
    };
    const onMove = (e) => {
      interactAt.current = Date.now();
      if (!mode) {
        // hover cursor feedback
        const over = pick(toWorld(e));
        canvas.style.cursor = over ? 'grab' : 'default';
        return;
      }
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      last = { x: e.clientX, y: e.clientY };
      userMovedRef.current = true; // panning or dragging = user owns the camera now
      if (mode === 'pan') {
        transformRef.current.x += dx;
        transformRef.current.y += dy;
      } else if (mode === 'box' && boxRef.current) {
        const p = toWorld(e);
        boxRef.current.x2 = p.x;
        boxRef.current.y2 = p.y;
      } else if (grabbed) {
        const k = transformRef.current.k;
        const gkey = keyOf(grabbed);
        // Grabbing a node that's part of the selection drags the WHOLE group;
        // otherwise just this node.
        const keys = selRef.current.has(gkey) && selRef.current.size > 1 ? [...selRef.current] : [gkey];
        for (const key of keys) {
          const off = manualRef.current.get(key) || { dx: 0, dy: 0 };
          manualRef.current.set(key, { dx: off.dx + dx / k, dy: off.dy + dy / k });
        }
        canvas.style.cursor = 'grabbing';
      }
    };
    let pendingSelect = 0;
    const onUp = (e) => {
      const wasDrag = moved >= 6;
      const hit = grabbed;
      const wasBox = mode === 'box';
      const box = boxRef.current;
      mode = null;
      grabbed = null;
      boxRef.current = null;
      canvas.style.cursor = 'default';
      if (ctrlToggled) return; // selection already toggled on pointerdown
      if (wasBox) {
        // Finalize the rubber-band: every node whose center is inside joins the
        // selection (shift keeps the existing selection, else it replaces it).
        const minX = Math.min(box.x1, box.x2);
        const maxX = Math.max(box.x1, box.x2);
        const minY = Math.min(box.y1, box.y2);
        const maxY = Math.max(box.y1, box.y2);
        const next = new Set(e.shiftKey ? selRef.current : []);
        for (const l of visibleRef.current) {
          const P = posOf(l);
          if (P.x >= minX && P.x <= maxX && P.y >= minY && P.y <= maxY) next.add(keyOf(l));
        }
        selRef.current = next;
        setSelCount(next.size);
        return;
      }
      if (wasDrag) return;
      if (!hit) {
        // Plain click on empty canvas clears the multi-selection.
        if (selRef.current.size) {
          selRef.current = new Set();
          setSelCount(0);
        }
        return;
      }
      // Click near the +/- affordance (below the badge) toggles expansion.
      const p = toWorld(e);
      const P = posOf(hit);
      const nearToggle = hit.hasKids && p.y > P.y + R - 6 && Math.abs(p.x - P.x) < 12;
      if (nearToggle) {
        toggle(hit.node);
        return;
      }
      // Plain click on a node makes it the sole selection and opens its detail.
      selRef.current = new Set([keyOf(hit)]);
      setSelCount(1);
      // Defer selection briefly so a double-click (expand) doesn't also select —
      // opening the detail panel mid-gesture would move the canvas under the
      // second click.
      clearTimeout(pendingSelect);
      pendingSelect = setTimeout(() => onSelect?.(hit.node), 260);
    };
    const onDbl = (e) => {
      clearTimeout(pendingSelect);
      const hit = pick(toWorld(e));
      if (hit?.hasKids) toggle(hit.node);
    };
    const onWheel = (e) => {
      interactAt.current = Date.now();
      userMovedRef.current = true; // zooming = user owns the camera now
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

    const onKey = (e) => {
      if (e.key === 'Escape' && selRef.current.size) {
        selRef.current = new Set();
        setSelCount(0);
        interactAt.current = Date.now(); // prompt a redraw so the rings clear now
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('dblclick', onDbl);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(pendingSelect);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSelect, posOf]);

  const toggle = (node) => {
    userMovedRef.current = true; // user is exploring — stop re-framing the camera under them
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
      <canvas ref={canvasRef} className="h-full w-full" />
      <div className="absolute bottom-4 right-4 z-10 flex items-center gap-2">
        {selCount > 0 && (
          <button
            onClick={() => {
              selRef.current = new Set();
              setSelCount(0);
            }}
            title="Clear the multi-selection (Esc)"
            className="flex items-center gap-1.5 rounded-lg border border-sky-400/50 bg-sky-500/15 px-3 py-1.5 text-[11px] font-medium text-sky-700 shadow-sm backdrop-blur transition hover:bg-sky-500/25"
          >
            {selCount} selected · drag to move · Esc ✕
          </button>
        )}
        <button
          onClick={autoArrange}
          title="Reset manual node positions to the tidy layout and fit to view"
          className="rounded-lg border border-slate-300/70 bg-white/90 px-3 py-1.5 text-[11px] font-medium text-slate-700 shadow-sm backdrop-blur transition hover:border-slate-400 hover:text-slate-900"
        >
          Auto arrange
        </button>
        <button
          onClick={fitAll}
          title="Fit the current arrangement to the viewport (keeps manual moves)"
          className="rounded-lg border border-slate-300/70 bg-white/90 px-3 py-1.5 text-[11px] font-medium text-slate-700 shadow-sm backdrop-blur transition hover:border-slate-400 hover:text-slate-900"
        >
          Fit
        </button>
      </div>
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
