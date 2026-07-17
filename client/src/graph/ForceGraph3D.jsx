import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import * as THREE from 'three';
import { GRAPH_STYLES } from './graphStyles';
import { groupColor, PROTOCOL_COLORS } from './buildGraph';

/**
 * Real three.js 3D node graph. Nodes are placed with the deterministic
 * spherical-tree layout, drawn as an InstancedMesh of low-poly spheres with
 * per-instance color and degree-based scale, and links as a single
 * LineSegments buffer. Drag orbits (yaw/pitch), wheel zooms, click selects.
 * Rendering is on-demand: frames are only produced during/shortly after
 * interaction, and the loop pauses while the tab is hidden.
 */
const CAM_DIST = 950;
const FOV = 50;
const MAX_3D_NODES = 50000; // GPU instancing keeps this smooth
const LABEL_COUNT = 40; // sprite labels for the highest-degree nodes only
const LINK_OPACITY = 0.35;
const IDLE_MS = 2000; // keep the rAF loop alive this long after interaction
const AUTO_ROTATE_SPEED = 0.0022; // rad/frame — a slow, cinematic spin

/** Strip the alpha channel from an rgba() color (link opacity is constant here). */
function opaqueColor(color) {
  const m = /^rgba\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,[^)]+\)$/.exec(String(color).trim());
  return m ? `rgb(${m[1]},${m[2]},${m[3]})` : color;
}

/** Same node sizing rule as the 2D renderers. */
function nodeRadius(n) {
  return n.kind === 'broker' || n.kind === 'opcua-server' || n.kind === 'i3x-server'
    ? 10
    : 4 + Math.sqrt(n.degree || 0) * 1.6;
}

function truncateLabel(label) {
  const s = String(label ?? '');
  return s.length > 20 ? `${s.slice(0, 19)}…` : s;
}

/** Canvas-textured billboard label (halo + fill from the style's label colors). */
function makeLabelSprite(text, labelStyle) {
  const fontSize = 28;
  const pad = 10;
  const font = `600 ${fontSize}px Inter, sans-serif`;
  const canvas = document.createElement('canvas');
  let ctx = canvas.getContext('2d');
  ctx.font = font;
  const w = Math.max(2, Math.ceil(ctx.measureText(text).width) + pad * 2);
  const h = fontSize + pad * 2;
  canvas.width = w;
  canvas.height = h;
  ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = labelStyle.halo;
  ctx.strokeText(text, w / 2, h / 2);
  ctx.fillStyle = labelStyle.color;
  ctx.fillText(text, w / 2, h / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  const worldH = 15; // world units; perspective scales it with distance
  sprite.scale.set(worldH * (w / h), worldH, 1);
  return sprite;
}

function positionLabel(sprite, n) {
  sprite.position.set(n.x, n.y + nodeRadius(n) + 10, n.z);
}

function disposeObject(obj) {
  if (obj.geometry) obj.geometry.dispose();
  const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
  for (const m of mats) {
    if (m.map) m.map.dispose();
    m.dispose();
  }
}

const ForceGraph3D = forwardRef(function ForceGraph3D(
  {
    data,
    styleId = 'constellation',
    selectedId = null,
    onSelect,
    colorByProtocol = false,
    nodeScale = 1, // 0.5–2  point-size multiplier
    linkOpacity = LINK_OPACITY, // 0–0.8  link line opacity
    autoRotate = false, // gentle continuous spin
    beautify = false // depth-graded colours + glow + auto-rotate
  },
  ref
) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const threeRef = useRef(null); // { renderer, scene, camera, rotGroup, requestRender }
  const objsRef = useRef(null); // per-dataset scene objects (rebuilt when data/style change)
  const nodesRef = useRef([]);
  const byIdRef = useRef(new Map());
  const rotRef = useRef({ yaw: 0.6, pitch: -0.35 });
  const zoomRef = useRef(1);
  const selSpriteRef = useRef(null);
  const autoRotateRef = useRef(false); // read by the render loop each frame
  const nodeScaleRef = useRef(nodeScale); // keeps the selection ring hugging scaled nodes
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const style = GRAPH_STYLES[styleId] || GRAPH_STYLES.constellation;
  const colorFor = useCallback(
    (n) => (colorByProtocol && n.protocol ? PROTOCOL_COLORS[n.protocol] || style.palette[0] : groupColor(n.group, style.palette)),
    [colorByProtocol, style]
  );

  const capped = data && data.nodes.length > MAX_3D_NODES;

  // Renderer / camera / controls — created once.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return undefined;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 20000);
    camera.position.set(0, 0, CAM_DIST);
    // Everything orbits by rotating this group; the camera only moves along z for zoom.
    const rotGroup = new THREE.Group();
    scene.add(rotGroup);
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
    dirLight.position.set(0.5, 1, 2);
    scene.add(dirLight);
    const raycaster = new THREE.Raycaster();

    // On-demand render loop: run only while interacting (plus a short tail).
    let raf = 0;
    let lastActive = 0;
    const renderFrame = () => {
      const rot = rotRef.current;
      rotGroup.rotation.set(rot.pitch, rot.yaw, 0); // Rx(pitch) ∘ Ry(yaw), same as the old projection
      camera.position.z = CAM_DIST / zoomRef.current;
      renderer.render(scene, camera);
    };
    const loop = () => {
      raf = 0;
      if (autoRotateRef.current) rotRef.current.yaw += AUTO_ROTATE_SPEED;
      renderFrame();
      const interacting = performance.now() - lastActive < IDLE_MS;
      if ((interacting || autoRotateRef.current) && !document.hidden) raf = requestAnimationFrame(loop);
    };
    const requestRender = (sustain = false) => {
      if (sustain) lastActive = performance.now();
      if (!raf && !document.hidden) raf = requestAnimationFrame(loop);
    };

    const resize = () => {
      const { width, height } = wrap.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      requestRender();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const onVisibility = () => {
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else {
        requestRender();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Analytic ray-sphere picking in layout space — much faster than
    // raycasting 50k instanced sphere geometries triangle-by-triangle.
    const ndc = new THREE.Vector2();
    const sphere = new THREE.Sphere();
    const hitPoint = new THREE.Vector3();
    const invWorld = new THREE.Matrix4();
    const localRay = new THREE.Ray();
    const pick = (e) => {
      const objs = objsRef.current;
      if (!objs) return null;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      camera.position.z = CAM_DIST / zoomRef.current;
      camera.updateMatrixWorld();
      raycaster.setFromCamera(ndc, camera);
      rotGroup.rotation.set(rotRef.current.pitch, rotRef.current.yaw, 0);
      rotGroup.updateMatrixWorld();
      invWorld.copy(rotGroup.matrixWorld).invert();
      localRay.copy(raycaster.ray).applyMatrix4(invWorld);
      const { positions, radii } = objs;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < radii.length; i++) {
        sphere.center.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        sphere.radius = radii[i] + 1.5;
        if (localRay.intersectSphere(sphere, hitPoint)) {
          const d = hitPoint.distanceToSquared(localRay.origin);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      return best >= 0 ? nodesRef.current[best] : null;
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
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      const rot = rotRef.current;
      rot.yaw += dx * 0.008;
      rot.pitch = Math.max(-1.5, Math.min(1.5, rot.pitch + dy * 0.008));
      requestRender(true);
    };
    const onUp = (e) => {
      canvas.style.cursor = 'grab';
      if (dragging && moved < 5) {
        const node = pick(e);
        if (node && onSelectRef.current) onSelectRef.current(node);
      }
      dragging = false;
    };
    const onWheel = (e) => {
      e.preventDefault();
      zoomRef.current = Math.max(0.15, Math.min(6, zoomRef.current * (e.deltaY < 0 ? 1.12 : 0.89)));
      requestRender(true);
    };
    canvas.style.cursor = 'grab';
    // Right-click a node to open its properties (suppress the native menu).
    const onContext = (e) => {
      const node = pick(e);
      if (node && onSelectRef.current) {
        e.preventDefault();
        onSelectRef.current(node);
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContext);

    threeRef.current = { renderer, scene, camera, rotGroup, requestRender };
    requestRender();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
      threeRef.current = null;
      renderer.dispose();
    };
  }, []);

  // Build the scene graph when data / style / coloring change.
  useEffect(() => {
    const three = threeRef.current;
    if (!three || !data) return undefined;

    const nodes = data.nodes.slice(0, MAX_3D_NODES).map((n) => ({ ...n }));
    const keep = new Set(nodes.map((n) => n.id));
    const links = data.links.filter((l) => keep.has(l.source) && keep.has(l.target)).map((l) => ({ ...l }));
    const maxDepth = sphericalTreeLayout(nodes, links);
    nodesRef.current = nodes;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    byIdRef.current = byId;

    const { scene, rotGroup, requestRender } = three;
    scene.background = new THREE.Color(style.background);

    const group = new THREE.Group();

    // Nodes: one instanced low-poly sphere with per-instance color + scale.
    const nodeGeo = new THREE.SphereGeometry(1, 12, 8);
    const nodeMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const nodeMesh = new THREE.InstancedMesh(nodeGeo, nodeMat, Math.max(1, nodes.length));
    nodeMesh.count = nodes.length;
    const m4 = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    const positions = new Float32Array(nodes.length * 3);
    const radii = new Float32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const r = nodeRadius(n);
      positions[i * 3] = n.x;
      positions[i * 3 + 1] = n.y;
      positions[i * 3 + 2] = n.z;
      radii[i] = r;
      pos.set(n.x, n.y, n.z);
      const s = r * nodeScaleRef.current;
      scl.set(s, s, s);
      nodeMesh.setMatrixAt(i, m4.compose(pos, quat, scl));
      nodeMesh.setColorAt(i, col.set(colorFor(n)));
    }
    nodeMesh.instanceMatrix.needsUpdate = true;
    if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
    group.add(nodeMesh);

    // Links: a single LineSegments buffer whose opacity/blending the look effects tune.
    let lineMat = null;
    if (links.length > 0) {
      const linePos = new Float32Array(links.length * 6);
      let j = 0;
      for (const l of links) {
        const a = byId.get(l.source);
        const b = byId.get(l.target);
        linePos[j++] = a.x;
        linePos[j++] = a.y;
        linePos[j++] = a.z;
        linePos[j++] = b.x;
        linePos[j++] = b.y;
        linePos[j++] = b.z;
      }
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
      lineMat = new THREE.LineBasicMaterial({
        color: new THREE.Color(opaqueColor(style.link.color)),
        transparent: true,
        opacity: linkOpacity,
        depthWrite: false
      });
      group.add(new THREE.LineSegments(lineGeo, lineMat));
    }

    // Labels: sprites for the highest-degree nodes only (text is expensive).
    const labelGroup = new THREE.Group();
    const labeled = new Set();
    const byDegree = nodes.slice().sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, LABEL_COUNT);
    for (const n of byDegree) {
      if (!n.label) continue;
      const sprite = makeLabelSprite(truncateLabel(n.label), style.label);
      positionLabel(sprite, n);
      labelGroup.add(sprite);
      labeled.add(n.id);
    }
    group.add(labelGroup);

    // Selection highlight: a wireframe shell scaled around the selected node.
    const highlight = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(style.selectedRing), wireframe: true, transparent: true, opacity: 0.9 })
    );
    highlight.visible = false;
    group.add(highlight);

    rotGroup.add(group);
    objsRef.current = { group, labelGroup, highlight, labeled, positions, radii, nodeMesh, nodeMat, lineMat, maxDepth };
    requestRender();

    return () => {
      rotGroup.remove(group);
      group.traverse(disposeObject);
      selSpriteRef.current = null;
      objsRef.current = null;
    };
  }, [data, style, colorFor]);

  // Auto-rotate is driven by a ref the render loop reads; Beautify also spins.
  useEffect(() => {
    autoRotateRef.current = autoRotate || beautify;
    if (autoRotateRef.current) threeRef.current?.requestRender();
  }, [autoRotate, beautify]);

  // Node colours: depth-graded ramp when Beautify is on, else the group palette.
  useEffect(() => {
    const three = threeRef.current;
    const objs = objsRef.current;
    if (!three || !objs?.nodeMesh) return;
    const nodes = nodesRef.current;
    const { nodeMesh, maxDepth } = objs;
    const inner = new THREE.Color(style.palette[0]);
    const outer = new THREE.Color(style.palette[style.palette.length - 1]);
    const c = new THREE.Color();
    for (let i = 0; i < nodes.length; i++) {
      if (beautify) {
        const t = maxDepth ? (nodes[i].depth || 0) / maxDepth : 0;
        c.copy(inner).lerp(outer, t);
      } else {
        c.set(colorFor(nodes[i]));
      }
      nodeMesh.setColorAt(i, c);
    }
    if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
    three.requestRender();
  }, [beautify, data, style, colorFor]);

  // Link opacity + optional additive glow when Beautify is on (skip light styles).
  useEffect(() => {
    const three = threeRef.current;
    const lineMat = objsRef.current?.lineMat;
    if (!three || !lineMat) return;
    const glow = beautify && style.id !== 'slate';
    lineMat.opacity = beautify ? Math.max(linkOpacity, 0.5) : linkOpacity;
    lineMat.blending = glow ? THREE.AdditiveBlending : THREE.NormalBlending;
    lineMat.needsUpdate = true;
    three.requestRender();
  }, [linkOpacity, beautify, data, style]);

  // Point size: rescale every instance around its stored base radius.
  useEffect(() => {
    nodeScaleRef.current = nodeScale;
    const three = threeRef.current;
    const objs = objsRef.current;
    if (!three || !objs?.nodeMesh) return;
    const nodes = nodesRef.current;
    const { nodeMesh, radii } = objs;
    const m4 = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const s = radii[i] * nodeScale;
      pos.set(n.x, n.y, n.z);
      scl.set(s, s, s);
      nodeMesh.setMatrixAt(i, m4.compose(pos, quat, scl));
    }
    nodeMesh.instanceMatrix.needsUpdate = true;
    three.requestRender();
  }, [nodeScale, data]);

  // Apply selection: move the highlight shell and label the selected node.
  useEffect(() => {
    const three = threeRef.current;
    const objs = objsRef.current;
    if (!three || !objs) return;
    const { highlight, labelGroup, labeled } = objs;

    if (selSpriteRef.current) {
      labelGroup.remove(selSpriteRef.current);
      disposeObject(selSpriteRef.current);
      selSpriteRef.current = null;
    }

    const node = selectedId != null ? byIdRef.current.get(selectedId) : null;
    if (node) {
      highlight.visible = true;
      highlight.position.set(node.x, node.y, node.z);
      highlight.scale.setScalar(nodeRadius(node) * nodeScaleRef.current + 3);
      if (node.label && !labeled.has(node.id)) {
        const sprite = makeLabelSprite(truncateLabel(node.label), style.label);
        positionLabel(sprite, node);
        labelGroup.add(sprite);
        selSpriteRef.current = sprite;
      }
    } else {
      highlight.visible = false;
    }
    three.requestRender();
  }, [selectedId, data, style, colorFor]);

  useImperativeHandle(ref, () => ({
    resetView: () => {
      rotRef.current = { yaw: 0.6, pitch: -0.35 };
      zoomRef.current = 1;
      if (threeRef.current) threeRef.current.requestRender();
    }
  }), []);

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
    n.depth = depth;
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
      n.depth = 0;
    }
  }
  let maxDepth = 0;
  for (const n of nodes) {
    if (n.depth > maxDepth) maxDepth = n.depth;
  }
  return maxDepth;
}
