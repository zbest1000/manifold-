import { useEffect, useRef, useCallback } from 'react';
import { GRAPH_STYLES } from './graphStyles';
import { groupColor, PROTOCOL_COLORS } from './buildGraph';

/**
 * WebGL2 renderer for very large ("show all") graphs. Nodes are drawn as GL
 * points and links as GL lines in a couple of draw calls, so hundreds of
 * thousands — into the millions — of nodes stay smooth to pan and zoom, where a
 * per-node 2D canvas loop would stall. Layout is a deterministic radial tree;
 * pan/zoom update a transform uniform (one draw call), and picking uses a CPU
 * spatial grid.
 *
 * The feature-rich 2D ForceGraph remains the default for normal-sized graphs
 * (labels, glow, curved links, live message-flow animation).
 */
export default function WebGLGraph({ data, styleId = 'constellation', selectedId = null, onSelect, colorByProtocol = false, labelDensity = 0.5, positions = null }) {
  const canvasRef = useRef(null);
  const labelCanvasRef = useRef(null);
  const wrapRef = useRef(null);
  const glRef = useRef(null);
  const labelDensityRef = useRef(labelDensity);
  const posRef = useRef(null);
  const progRef = useRef({});
  const buffersRef = useRef({});
  const countsRef = useRef({ nodes: 0, lineVerts: 0 });
  const nodesRef = useRef([]);
  const gridRef = useRef(null);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const selectedRef = useRef(null);

  const style = GRAPH_STYLES[styleId] || GRAPH_STYLES.constellation;
  const colorFor = useCallback(
    (n) => (colorByProtocol && n.protocol ? PROTOCOL_COLORS[n.protocol] || style.palette[0] : groupColor(n.group, style.palette)),
    [colorByProtocol, style]
  );

  const draw = useCallback(() => {
    const gl = glRef.current;
    if (!gl) return;
    const { w, h } = sizeRef.current;
    const t = transformRef.current;
    const bg = hexToRgb(style.background);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const { nodes, lineVerts } = countsRef.current;
    const b = buffersRef.current;

    // Links
    if (lineVerts > 0) {
      const lp = progRef.current.line;
      gl.useProgram(lp.program);
      gl.uniform2f(lp.u_translate, t.x, t.y);
      gl.uniform1f(lp.u_scale, t.k);
      gl.uniform2f(lp.u_resolution, w, h);
      const lc = hexToRgb(style.link.color);
      // Zoom-aware opacity: faint when zoomed out (tens of thousands of edges
      // would otherwise blob into a solid mass), stronger as you zoom in and only
      // a few connection lines are on screen — so structure stays readable next
      // to the labels.
      const edgeAlpha = Math.min(0.6, 0.16 + t.k * 0.06);
      gl.uniform4f(lp.u_color, lc[0], lc[1], lc[2], edgeAlpha);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.linePos);
      gl.enableVertexAttribArray(lp.a_pos);
      gl.vertexAttribPointer(lp.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINES, 0, lineVerts);
    }

    // Nodes
    if (nodes > 0) {
      const pp = progRef.current.point;
      gl.useProgram(pp.program);
      gl.uniform2f(pp.u_translate, t.x, t.y);
      gl.uniform1f(pp.u_scale, t.k);
      gl.uniform2f(pp.u_resolution, w, h);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
      gl.enableVertexAttribArray(pp.a_pos);
      gl.vertexAttribPointer(pp.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.color);
      gl.enableVertexAttribArray(pp.a_color);
      gl.vertexAttribPointer(pp.a_color, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.size);
      gl.enableVertexAttribArray(pp.a_size);
      gl.vertexAttribPointer(pp.a_size, 1, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, nodes);
    }

    drawLabels(t, w, h);
  }, [style]);

  // Label overlay: WebGL can't cheaply draw text, so labels are painted on a 2D
  // canvas layered on top — but ONLY for nodes actually on screen and large
  // enough to read at the current zoom (plus servers/brokers and the selection,
  // which are always labelled). Viewport culling + a hard cap keep this to tens/
  // low-hundreds of fillText calls per frame regardless of total graph size, so
  // the renderer stays fast while the show-all view becomes legible as you zoom.
  const drawLabels = useCallback(
    (t, w, h) => {
      const canvas = labelCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, w, h);

      const dpr = window.devicePixelRatio || 1;
      const nodes = nodesRef.current;
      const sel = selectedRef.current;
      // Density knob (0..1): higher = more labels (bigger cap, smaller nodes get
      // labelled); lower = only the largest/nearest few; 0 turns labels off.
      const d = labelDensityRef.current;
      if (d <= 0.001) return;
      const MAX = Math.round(80 + d * 1120); // ~80 → ~1200 labels
      const MIN_SCREEN_R = (9 - d * 7) * dpr; // ~9px (sparse) → ~2px (dense) radius to qualify
      const font = `${Math.round(11 * dpr)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.font = font;
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      const labelColor = style.label?.color || '#cbd5e1';
      const haloColor = style.background || '#000';
      const margin = 40 * dpr;

      let drawn = 0;
      const paint = (n, sx, sy, r, strong) => {
        const text = n.label || n.id;
        ctx.lineWidth = 3 * dpr;
        ctx.strokeStyle = haloColor;
        ctx.strokeText(text, sx + r + 3 * dpr, sy);
        ctx.fillStyle = strong ? '#fff' : labelColor;
        ctx.fillText(text, sx + r + 3 * dpr, sy);
      };

      // First pass: always-on labels (servers/brokers + the selected node).
      for (const n of nodes) {
        const isHub = n.kind === 'broker' || n.kind === 'opcua-server' || n.kind === 'i3x-server';
        if (!isHub && n.id !== sel) continue;
        const sx = n.x * t.k + t.x;
        const sy = n.y * t.k + t.y;
        if (sx < -margin || sy < -margin || sx > w + margin || sy > h + margin) continue;
        paint(n, sx, sy, (n.size || 4) * t.k, true);
      }

      // Second pass: readable, on-screen nodes up to the cap.
      for (const n of nodes) {
        if (drawn >= MAX) break;
        const isHub = n.kind === 'broker' || n.kind === 'opcua-server' || n.kind === 'i3x-server';
        if (isHub || n.id === sel) continue;
        const r = (n.size || 4) * t.k;
        if (r < MIN_SCREEN_R) continue;
        const sx = n.x * t.k + t.x;
        const sy = n.y * t.k + t.y;
        if (sx < -margin || sy < -margin || sx > w + margin || sy > h + margin) continue;
        paint(n, sx, sy, r, false);
        drawn++;
      }
    },
    [style]
  );

  const fitAll = useCallback(() => {
    const nodes = nodesRef.current;
    if (!nodes.length) return;
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
    const { w, h } = sizeRef.current;
    if (!w) return;
    const pad = 60;
    const k = Math.min((w - pad) / Math.max(maxX - minX, 1), (h - pad) / Math.max(maxY - minY, 1));
    transformRef.current = { k, x: w / 2 - (k * (minX + maxX)) / 2, y: h / 2 - (k * (minY + maxY)) / 2 };
    draw();
  }, [draw]);

  // Build GL programs + upload geometry when data changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) return;
    glRef.current = gl;

    if (!progRef.current.point) {
      progRef.current.point = buildProgram(gl, POINT_VS, POINT_FS, ['a_pos', 'a_color', 'a_size'], ['u_translate', 'u_scale', 'u_resolution']);
      progRef.current.line = buildProgram(gl, LINE_VS, LINE_FS, ['a_pos'], ['u_translate', 'u_scale', 'u_resolution', 'u_color']);
      buffersRef.current = { pos: gl.createBuffer(), color: gl.createBuffer(), size: gl.createBuffer(), linePos: gl.createBuffer() };
    }

    // Positions come from either the server-computed layout (organic sfdp/fcose,
    // passed in via `positions`) or the built-in deterministic radial layout.
    const nodes = data.nodes.map((n) => ({ ...n }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = data.links.filter((l) => byId.has(l.source) && byId.has(l.target));
    if (positions) {
      for (const n of nodes) {
        const p = positions[n.id];
        n.x = p ? p.x : 0;
        n.y = p ? p.y : 0;
      }
    } else {
      radialLayout(nodes, links);
    }
    nodesRef.current = nodes;
    const posChanged = positions !== posRef.current;
    posRef.current = positions;

    const pos = new Float32Array(nodes.length * 2);
    const color = new Float32Array(nodes.length * 3);
    const size = new Float32Array(nodes.length);
    nodes.forEach((n, i) => {
      pos[i * 2] = n.x;
      pos[i * 2 + 1] = n.y;
      const c = hexToRgb(colorFor(n));
      color[i * 3] = c[0];
      color[i * 3 + 1] = c[1];
      color[i * 3 + 2] = c[2];
      const s = n.kind === 'broker' || n.kind === 'opcua-server' || n.kind === 'i3x-server' ? 12 : 4 + Math.sqrt(n.degree || 0) * 1.5;
      n.size = s; // reused by the label overlay + picking
      size[i] = s;
    });
    const linePos = new Float32Array(links.length * 4);
    links.forEach((l, i) => {
      const a = byId.get(l.source);
      const bb = byId.get(l.target);
      linePos[i * 4] = a.x;
      linePos[i * 4 + 1] = a.y;
      linePos[i * 4 + 2] = bb.x;
      linePos[i * 4 + 3] = bb.y;
    });

    const b = buffersRef.current;
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.color);
    gl.bufferData(gl.ARRAY_BUFFER, color, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.size);
    gl.bufferData(gl.ARRAY_BUFFER, size, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.linePos);
    gl.bufferData(gl.ARRAY_BUFFER, linePos, gl.STATIC_DRAW);
    countsRef.current = { nodes: nodes.length, lineVerts: links.length * 2 };

    buildGrid(nodes, gridRef);
    // Re-frame when the layout itself changes (radial ⇄ server), but not on plain
    // data updates (which would fight the user's pan/zoom).
    if (posChanged) requestAnimationFrame(() => fitAll());
    draw();
  }, [data, colorFor, draw, positions, fitAll]);

  useEffect(() => {
    selectedRef.current = selectedId;
    draw();
  }, [selectedId, draw]);

  useEffect(() => {
    labelDensityRef.current = labelDensity;
    draw();
  }, [labelDensity, draw]);

  // Sizing + interaction (once).
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const labelCanvas = labelCanvasRef.current;
    let centered = false;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = wrap.getBoundingClientRect();
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      if (labelCanvas) {
        labelCanvas.width = width * dpr;
        labelCanvas.height = height * dpr;
        labelCanvas.style.width = `${width}px`;
        labelCanvas.style.height = `${height}px`;
      }
      sizeRef.current = { w: canvas.width, h: canvas.height };
      if (!centered && width > 0) {
        centered = true;
        fitAll();
      }
      draw();
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const toGraph = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const t = transformRef.current;
      const px = (clientX - rect.left) * dpr;
      const py = (clientY - rect.top) * dpr;
      return { x: (px - t.x) / t.k, y: (py - t.y) / t.k };
    };

    let dragging = false;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e) => {
      dragging = true;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onMove = (e) => {
      if (!dragging) return;
      const dpr = window.devicePixelRatio || 1;
      const dx = (e.clientX - lastX) * dpr;
      const dy = (e.clientY - lastY) * dpr;
      lastX = e.clientX;
      lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      transformRef.current.x += dx;
      transformRef.current.y += dy;
      draw();
    };
    const onUp = (e) => {
      if (dragging && moved < 6) {
        const { x, y } = toGraph(e.clientX, e.clientY);
        const hit = pickFromGrid(x, y, gridRef.current);
        if (hit && onSelect) onSelect(hit);
      }
      dragging = false;
    };
    const onWheel = (e) => {
      e.preventDefault();
      const dpr = window.devicePixelRatio || 1;
      const t = transformRef.current;
      const rect = canvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * dpr;
      const py = (e.clientY - rect.top) * dpr;
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      const nk = Math.max(0.02, Math.min(20, t.k * factor));
      // zoom toward cursor
      t.x = px - (px - t.x) * (nk / t.k);
      t.y = py - (py - t.y) * (nk / t.k);
      t.k = nk;
      draw();
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
      <canvas ref={labelCanvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
    </div>
  );
}

// ---------------------------------------------------------------------------
const POINT_VS = `#version 300 es
in vec2 a_pos; in vec3 a_color; in float a_size;
uniform vec2 u_translate; uniform float u_scale; uniform vec2 u_resolution;
out vec3 v_color;
void main() {
  vec2 screen = a_pos * u_scale + u_translate;
  vec2 clip = (screen / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = max(1.0, a_size * u_scale);
  v_color = a_color;
}`;
const POINT_FS = `#version 300 es
precision mediump float;
in vec3 v_color; out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  outColor = vec4(v_color, 1.0);
}`;
const LINE_VS = `#version 300 es
in vec2 a_pos;
uniform vec2 u_translate; uniform float u_scale; uniform vec2 u_resolution;
void main() {
  vec2 screen = a_pos * u_scale + u_translate;
  vec2 clip = (screen / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;
const LINE_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color; out vec4 outColor;
void main() { outColor = u_color; }`;

function buildProgram(gl, vsSrc, fsSrc, attribs, uniforms) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  const out = { program };
  for (const a of attribs) out[a] = gl.getAttribLocation(program, a);
  for (const u of uniforms) out[u] = gl.getUniformLocation(program, u);
  return out;
}

// Parse hex (#rgb / #rrggbb) OR rgb()/rgba() into normalized [r,g,b]. Several
// style presets specify link colors as rgba() strings, so a hex-only parser
// silently returned black — making connection lines invisible on dark themes.
function hexToRgb(color) {
  const s = String(color || '#000000').trim();
  const full = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})/i.exec(s);
  if (full) return [parseInt(full[1], 16) / 255, parseInt(full[2], 16) / 255, parseInt(full[3], 16) / 255];
  const short = /^#([a-f\d])([a-f\d])([a-f\d])$/i.exec(s);
  if (short) return [parseInt(short[1] + short[1], 16) / 255, parseInt(short[2] + short[2], 16) / 255, parseInt(short[3] + short[3], 16) / 255];
  const rgb = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
  if (rgb) return [Math.min(1, +rgb[1] / 255), Math.min(1, +rgb[2] / 255), Math.min(1, +rgb[3] / 255)];
  return [0, 0, 0];
}

// Deterministic radial-tree layout (proportional wedges), O(n).
function radialLayout(nodes, links) {
  const childrenOf = new Map();
  const hasParent = new Set();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const l of links) {
    if (!childrenOf.has(l.source)) childrenOf.set(l.source, []);
    childrenOf.get(l.source).push(l.target);
    hasParent.add(l.target);
  }
  const leaves = new Map();
  const count = (id, g) => {
    if (leaves.has(id)) return leaves.get(id);
    if (g.has(id)) return 1;
    g.add(id);
    const k = childrenOf.get(id) || [];
    let c = k.length === 0 ? 1 : 0;
    for (const x of k) c += count(x, g);
    leaves.set(id, c || 1);
    return leaves.get(id);
  };
  const roots = nodes.filter((n) => !hasParent.has(n.id));
  for (const r of roots) count(r.id, new Set());
  const ring = 240;
  const place = (id, a0, a1, d, g) => {
    const n = byId.get(id);
    if (!n || g.has(id)) return;
    g.add(id);
    const mid = (a0 + a1) / 2;
    n.x = Math.cos(mid) * d * ring;
    n.y = Math.sin(mid) * d * ring;
    const kids = childrenOf.get(id) || [];
    const total = kids.reduce((s, k) => s + (leaves.get(k) || 1), 0) || 1;
    let a = a0;
    for (const k of kids) {
      const span = ((leaves.get(k) || 1) / total) * (a1 - a0);
      place(k, a, a + span, d + 1, g);
      a += span;
    }
  };
  const total = roots.reduce((s, r) => s + (leaves.get(r.id) || 1), 0) || 1;
  let a = 0;
  const g = new Set();
  for (const r of roots) {
    const span = ((leaves.get(r.id) || 1) / total) * Math.PI * 2;
    place(r.id, a, a + span, 1, g);
    a += span;
  }
  for (const n of nodes) if (n.x === undefined) { n.x = 0; n.y = 0; }
}

function buildGrid(nodes, gridRef) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
  }
  const cell = 30;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const map = new Map();
  for (const n of nodes) {
    const key = Math.floor((n.y - minY) / cell) * cols + Math.floor((n.x - minX) / cell);
    let bucket = map.get(key);
    if (!bucket) { bucket = []; map.set(key, bucket); }
    bucket.push(n);
  }
  gridRef.current = { minX, minY, cell, cols, map };
}

function pickFromGrid(gx, gy, grid) {
  if (!grid) return null;
  const { minX, minY, cell, cols, map } = grid;
  let best = null;
  let bestD = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const key = Math.floor((gy - minY) / cell + dy) * cols + Math.floor((gx - minX) / cell + dx);
      const bucket = map.get(key);
      if (!bucket) continue;
      for (const n of bucket) {
        const r = (n.kind && n.kind.endsWith('server') ? 12 : 4 + Math.sqrt(n.degree || 0) * 1.5) + 6;
        const d = (n.x - gx) ** 2 + (n.y - gy) ** 2;
        if (d <= r * r && d < bestD) { best = n; bestD = d; }
      }
    }
  }
  return best;
}
