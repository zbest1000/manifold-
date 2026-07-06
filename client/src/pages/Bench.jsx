import { useEffect, useMemo, useRef, useState } from 'react';
import WebGLGraph from '@/graph/WebGLGraph';
import { buildMqttGraph } from '@/graph/buildGraph';
import { api } from '@/lib/api';

/**
 * Internal benchmark / verification page (not linked in the nav). Renders a
 * synthetic MQTT topic graph of a requested size with a chosen big-graph renderer
 * so the show-all renderers can be exercised deterministically — no broker or live
 * data needed. Drives automated Playwright verification at 50k+ nodes.
 *
 *   /bench?n=50000&r=webgl      built-in WebGL renderer
 *   /bench?n=50000&r=sigma      Sigma.js renderer
 *
 * Exposes window.__bench = { ready, renderer, requested, nodes, links, buildMs, renderMs }.
 */
export default function Bench() {
  const params = new URLSearchParams(window.location.search);
  const n = Math.max(1, Math.min(1_000_000, Number(params.get('n')) || 50_000));
  const renderer = 'webgl'; // single big-graph renderer (Sigma experiment removed)
  const density = params.has('d') ? Math.max(0, Math.min(1, Number(params.get('d')))) : 0.5;
  const skew = params.get('skew') === '1'; // irregular (realistic) topic tree vs uniform
  const force = params.get('force') === '1'; // fetch server sfdp layout (needs backend)
  const [phase, setPhase] = useState('building');
  const [positions, setPositions] = useState(null);
  const t0Ref = useRef(0);

  // Build a synthetic topic hierarchy with ~n leaf topics.
  const { graph, buildMs } = useMemo(() => {
    const t = performance.now();
    const topics = [];
    // factory/area{a}/line{l}/dev{d}/{metric} — shared prefixes keep it realistic.
    const metrics = ['temp', 'pressure', 'flow', 'state', 'rpm', 'level', 'vibration', 'power'];
    if (skew) {
      // Irregular tree (closer to a real broker): uneven fan-out at every level and
      // a varying number of metrics per device — so the radial layout is lumpy, not
      // a symmetric sunburst. Seeded LCG so runs are reproducible.
      let seed = 1337;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      let dev = 0;
      const areas = 8 + Math.floor(rnd() * 24);
      for (let a = 0; a < areas && topics.length < n; a++) {
        const lines = 1 + Math.floor(rnd() * rnd() * 60); // heavily skewed: many small, few huge
        for (let l = 0; l < lines && topics.length < n; l++) {
          const nDev = 1 + Math.floor(rnd() * rnd() * 40);
          for (let d = 0; d < nDev && topics.length < n; d++) {
            const id = dev++;
            const nMetric = 1 + Math.floor(rnd() * 8);
            for (let m = 0; m < nMetric && topics.length < n; m++) {
              topics.push({ topic: `factory/area${a}/line${l}/dev${id}/${metrics[m]}`, messageCount: 1, type: 'telemetry' });
            }
          }
        }
      }
    } else {
      const perDev = 4;
      const devs = Math.ceil(n / perDev);
      for (let i = 0; i < devs; i++) {
        const a = i % 50;
        const l = i % 500;
        for (let m = 0; m < perDev && topics.length < n; m++) {
          topics.push({ topic: `factory/area${a}/line${l}/dev${i}/${metrics[m]}`, messageCount: 1, type: 'telemetry' });
        }
      }
    }
    const broker = { id: 'bench', name: 'Bench Broker', host: 'localhost', port: 1883, status: 'connected' };
    const g = buildMqttGraph(broker, topics, { maxNodes: Infinity });
    return { graph: g, buildMs: Math.round(performance.now() - t) };
  }, [n, skew]);

  // Optionally fetch the server-computed sfdp layout (organic look at scale).
  useEffect(() => {
    if (!force) return;
    let cancelled = false;
    api
      .computeLayout(graph, 'sfdp')
      .then((res) => !cancelled && setPositions(res.positions))
      .catch(() => !cancelled && setPositions(null));
    return () => {
      cancelled = true;
    };
  }, [graph, force]);

  useEffect(() => {
    // In force mode, wait for the server layout before declaring ready.
    if (force && !positions) {
      setPhase('laying out');
      return undefined;
    }
    t0Ref.current = performance.now();
    setPhase('rendering');
    // Two rAFs after mount ≈ the renderer has drawn at least one frame.
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const renderMs = Math.round(performance.now() - t0Ref.current);
        window.__bench = {
          ready: true,
          renderer,
          layout: force ? 'sfdp' : 'radial',
          requested: n,
          nodes: graph.nodes.length,
          links: graph.links.length,
          buildMs,
          renderMs
        };
        setPhase('ready');
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      delete window.__bench;
    };
  }, [graph, renderer, n, buildMs, force, positions]);

  return (
    <div className="relative h-screen w-screen bg-black">
      <WebGLGraph data={graph} styleId="constellation" labelDensity={density} positions={positions} />
      <div
        data-testid="bench-status"
        className="pointer-events-none absolute left-2 top-2 rounded bg-white/10 px-2 py-1 font-mono text-[11px] text-white"
      >
        {renderer} · req {n.toLocaleString()} · nodes {graph.nodes.length.toLocaleString()} · links{' '}
        {graph.links.length.toLocaleString()} · build {buildMs}ms · {phase}
      </div>
    </div>
  );
}
