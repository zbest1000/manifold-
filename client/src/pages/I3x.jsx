import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, Plug, LogOut, X, Activity, Layers, ListTree, Search, Box, Maximize2, PanelRight } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import ForceGraph from '@/graph/ForceGraph';
import ForceGraph3D from '@/graph/ForceGraph3D';
import { buildI3xGraph, collapseGraph } from '@/graph/buildGraph';
import GraphToolbar from '@/components/GraphToolbar';
import GraphLegend from '@/components/GraphLegend';
import Graph3DControls from '@/components/Graph3DControls';
import GraphSearch from '@/components/GraphSearch';
import GraphTree from '@/components/GraphTree';
import JsonView from '@/components/JsonView';
import { downloadDataUrl, downloadJson } from '@/lib/download';
import { useStore } from '@/store/store';
import { Card, Button, Badge, Input, Field, EmptyState } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import ViewTab from '@/components/ViewTab';


export default function I3x() {
  const graphStyle = useStore((s) => s.graphStyle);
  const showMinimap = useStore((s) => s.showMinimap);
  // i3X object graphs are hierarchical (parentId) — default to the client
  // `tree` layout, kept per-view so it doesn't override the MQTT graph's pref.
  const [graphLayout, setGraphLayout] = useState('tree');
  const [matchIds, setMatchIds] = useState(null);
  const [view, setView] = useState('graph');
  const [treeFilter, setTreeFilter] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const graphRef = useRef(null);
  const graph3dRef = useRef(null);
  // 3D look-and-feel controls (shared component, local state per view).
  const [nodeScale3d, setNodeScale3d] = useState(1);
  const [linkOpacity3d, setLinkOpacity3d] = useState(0.35);
  const [autoRotate3d, setAutoRotate3d] = useState(false);
  const [beautify3d, setBeautify3d] = useState(false);

  // Selecting a node opens its details; the Properties toolbar button reopens it.
  const selectNode = (n) => {
    setSelected(n);
    setPanelOpen(Boolean(n));
  };

  const [status, setStatus] = useState(null);
  const [form, setForm] = useState({ baseUrl: '', token: '' });
  const [busy, setBusy] = useState(false);
  const [objects, setObjects] = useState([]);
  const [namespaces, setNamespaces] = useState([]);
  const [selected, setSelected] = useState(null);

  const refreshStatus = () => api.i3xStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    refreshStatus();
  }, []);

  const connected = status?.configured && Boolean(status?.info);

  useEffect(() => {
    if (!connected) return;
    api.i3xObjects().then((r) => setObjects(r.objects)).catch((e) => toast.error(e.message));
    api.i3xNamespaces().then((r) => setNamespaces(r.namespaces)).catch(() => {});
  }, [connected]);

  const server = useMemo(() => ({ baseUrl: status?.baseUrl, info: status?.info }), [status]);
  const fullGraph = useMemo(() => {
    if (!connected) return { nodes: [], links: [] };
    return buildI3xGraph(server, objects);
  }, [connected, server, objects]);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const collapseKey = [...collapsed].sort().join('|');
  const graph = useMemo(() => collapseGraph(fullGraph, collapsed), [fullGraph, collapseKey]);
  const groupsPresent = useMemo(() => new Set(graph.nodes.map((n) => n.group)), [graph]);

  const toggleCollapse = useCallback((node) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }, []);

  const refitSoon = useCallback(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => graphRef.current?.fitTo()));
  }, []);

  // Collapse everything below `level` (Infinity = expand all), like Topics.
  const expandToLevel = useCallback(
    (level) => {
      if (!Number.isFinite(level)) {
        setCollapsed(new Set());
        refitSoon();
        return;
      }
      const childrenOf = new Map();
      const incoming = new Set();
      for (const l of fullGraph.links) {
        const s = typeof l.source === 'object' ? l.source.id : l.source;
        const t = typeof l.target === 'object' ? l.target.id : l.target;
        if (!childrenOf.has(s)) childrenOf.set(s, []);
        childrenOf.get(s).push(t);
        incoming.add(t);
      }
      const depth = new Map();
      const queue = fullGraph.nodes.filter((n) => !incoming.has(n.id)).map((n) => (depth.set(n.id, 0), [n.id, 0]));
      while (queue.length) {
        const [id, d] = queue.shift();
        for (const c of childrenOf.get(id) || []) {
          if (!depth.has(c)) {
            depth.set(c, d + 1);
            queue.push([c, d + 1]);
          }
        }
      }
      const next = new Set();
      for (const n of fullGraph.nodes) {
        if ((depth.get(n.id) ?? 0) >= level && childrenOf.get(n.id)?.length) next.add(n.id);
      }
      setCollapsed(next);
      refitSoon();
    },
    [fullGraph, refitSoon]
  );

  const connect = async () => {
    setBusy(true);
    try {
      const s = await api.i3xConnect({ baseUrl: form.baseUrl, token: form.token || undefined });
      setStatus(s);
      toast.success(`Connected to i3X (${s.info?.serverName || s.baseUrl})`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    try {
      setStatus(await api.i3xReset());
      setObjects([]);
      setNamespaces([]);
      setSelected(null);
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (!connected) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="i3X"
          subtitle="Discover and visualize a Common Contextual Manufacturing Information (i3X) server"
          actions={<Badge>not connected</Badge>}
        />
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-2xl">
            <Card className="p-6">
              <div className="mb-4 flex items-center gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-teal-400 to-cyan-600 shadow-lg">
                  <Boxes size={20} className="text-white" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-slate-100">Connect an i3X server</h2>
                  <p className="text-xs text-slate-500">The server is verified via its <span className="mono">/info</span> endpoint before objects are loaded.</p>
                </div>
              </div>
              <div className="space-y-4">
                <Field label="Base URL">
                  <Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.i3x.dev/v1" />
                </Field>
                <Field label="Bearer token (optional)">
                  <Input type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />
                </Field>
              </div>
              <div className="mt-5 flex justify-end">
                <Button onClick={connect} disabled={busy || !form.baseUrl}>
                  <Plug size={15} /> {busy ? 'Verifying…' : 'Connect'}
                </Button>
              </div>
              <p className="mt-4 text-xs text-slate-500">
                Tip: run a network scan on the Discovery page to auto-detect i3X servers on your network.
              </p>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="i3X"
        subtitle={`${server.info?.serverName || server.baseUrl} · ${objects.length} objects · ${namespaces.length} namespaces`}
        actions={
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-xl border border-white/10">
              <ViewTab active={view === 'graph'} onClick={() => setView('graph')} icon={Boxes} label="Graph" />
              <ViewTab active={view === '3d'} onClick={() => setView('3d')} icon={Box} label="3D" />
              <ViewTab active={view === 'tree'} onClick={() => setView('tree')} icon={ListTree} label="Tree" />
            </div>
            <Badge status="connected">i3X {server.info?.specVersion || ''}</Badge>
            <Button variant="outline" onClick={disconnect}>
              <LogOut size={15} /> Disconnect
            </Button>
          </div>
        }
      />

      <div className="relative flex flex-1 overflow-hidden">
        {view === 'tree' ? (
          <div className="flex w-full max-w-md flex-col border-r border-white/5 bg-surface-900/30">
            <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2">
              <Search size={14} className="text-slate-500" />
              <input
                value={treeFilter}
                onChange={(e) => setTreeFilter(e.target.value)}
                placeholder="Filter objects…"
                className="w-full bg-transparent text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none"
              />
            </div>
            <GraphTree
              nodes={graph.nodes}
              links={graph.links}
              selectedId={selected?.id || null}
              onSelect={selectNode}
              filter={treeFilter}
            />
          </div>
        ) : view === '3d' ? (
          <div className="relative flex-1">
            <ForceGraph3D
              ref={graph3dRef}
              data={graph}
              styleId={graphStyle}
              selectedId={selected?.id || null}
              onSelect={selectNode}
              nodeScale={nodeScale3d}
              linkOpacity={linkOpacity3d}
              autoRotate={autoRotate3d}
              beautify={beautify3d}
            />
            <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
              <button
                onClick={() => selected?.kind === 'i3x-object' && setPanelOpen(true)}
                disabled={selected?.kind !== 'i3x-object'}
                title={selected?.kind === 'i3x-object' ? 'Show properties of the selected object' : 'Select an object first'}
                className={clsx(
                  'flex items-center gap-1.5 rounded-xl border px-2.5 py-2 text-sm backdrop-blur transition',
                  selected?.kind === 'i3x-object'
                    ? 'border-white/10 bg-surface-900/80 text-slate-300 hover:border-white/20 hover:text-slate-100'
                    : 'cursor-not-allowed border-white/5 bg-surface-900/60 text-slate-600'
                )}
              >
                <PanelRight size={15} />
                <span className="hidden font-medium sm:inline">Properties</span>
              </button>
              <button
                onClick={() => graph3dRef.current?.resetView()}
                title="Reset the camera to the default angle and zoom"
                className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-surface-900/80 px-2.5 py-2 text-sm text-slate-300 backdrop-blur transition hover:border-white/20 hover:text-slate-100"
              >
                <Maximize2 size={15} />
                <span className="hidden font-medium sm:inline">Reset view</span>
              </button>
            </div>
            <Graph3DControls
              beautify={beautify3d}
              onBeautify={() => setBeautify3d((v) => !v)}
              autoRotate={autoRotate3d}
              onAutoRotate={() => setAutoRotate3d((v) => !v)}
              nodeScale={nodeScale3d}
              onNodeScale={setNodeScale3d}
              linkOpacity={linkOpacity3d}
              onLinkOpacity={setLinkOpacity3d}
            />
            <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-[11px] text-slate-500 backdrop-blur">
              Drag to rotate · scroll to zoom · click a node for details
            </div>
            <GraphLegend styleId={graphStyle} groups={groupsPresent} />
          </div>
        ) : (
          <div className="relative flex-1">
            {objects.length === 0 ? (
              <EmptyState icon={Layers} title="No objects returned" hint="This i3X server exposed no objects." />
            ) : (
              <>
                <GraphSearch nodes={graph.nodes} onMatches={setMatchIds} onFit={(ids) => graphRef.current?.fitTo(ids)} onSelect={selectNode} />
                <GraphToolbar
                  onFit={() => graphRef.current?.fitTo()}
                  onExportPng={() => downloadDataUrl(graphRef.current?.exportPng(), 'i3x-graph.png')}
                  onExportJson={() => downloadJson(graphRef.current?.exportGraph(), 'i3x-graph.json')}
                  layoutValue={graphLayout}
                  onLayoutChange={setGraphLayout}
                  onBeautify={() => setGraphLayout(graphLayout === 'radial' ? 'tree' : 'radial')}
                  onProperties={() => setPanelOpen(true)}
                  hasSelection={selected?.kind === 'i3x-object'}
                  onExpandLevel={expandToLevel}
                />
                <ForceGraph
                  ref={graphRef}
                  data={graph}
                  styleId={graphStyle}
                  layoutId={graphLayout}
                  selectedId={selected?.id || null}
                  onSelect={selectNode}
                  onExpand={toggleCollapse}
                  matchIds={matchIds}
                  minimap={showMinimap}
                />
                <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-[11px] text-slate-500 backdrop-blur">
                  Object graph · click a node to read its value and history
                </div>
                <GraphLegend styleId={graphStyle} groups={groupsPresent} />
              </>
            )}
          </div>
        )}

        {selected && selected.kind === 'i3x-object' && panelOpen && (
          <ObjectPanel node={selected} onClose={() => setPanelOpen(false)} />
        )}
      </div>
    </div>
  );
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function ObjectPanel({ node, onClose }) {
  const elementId = node.meta?.elementId;
  const [value, setValue] = useState(null);
  const [history, setHistory] = useState(null);

  useEffect(() => {
    if (!elementId) return;
    setValue(null);
    setHistory(null);
    api.i3xValue([elementId]).then((r) => setValue(r.results?.[0] ?? null)).catch(() => setValue(null));
  }, [elementId]);

  const loadHistory = async () => {
    try {
      const r = await api.i3xHistory({ elementIds: [elementId], startTime: isoDaysAgo(7), endTime: isoDaysAgo(0) });
      setHistory(r.results?.[0]?.values || []);
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-white/5 bg-surface-900/50">
      <div className="flex items-start justify-between gap-2 border-b border-white/5 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-slate-500">
            {node.meta?.isComposition ? 'Composition object' : 'Object'}
          </p>
          <p className="mt-0.5 break-all text-sm font-medium text-slate-100">{node.label}</p>
          <p className="mono mt-0.5 break-all text-[11px] text-slate-500">{elementId}</p>
        </div>
        <button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-300">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {value && (
          <Card className="border-accent-500/20 p-3">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-accent-400">
              <Activity size={12} /> Current value
            </p>
            <p className="mono break-all text-lg font-semibold text-slate-100">
              {typeof value.value === 'object' ? JSON.stringify(value.value) : String(value.value)}
            </p>
            {value.timestamp && <p className="mt-1 text-[11px] text-slate-500">{new Date(value.timestamp).toLocaleString()}</p>}
            {value.quality != null && <p className="text-[11px] text-slate-500">quality: {String(value.quality)}</p>}
          </Card>
        )}

        <Button variant="subtle" className="w-full" onClick={loadHistory}>
          Load 7-day history
        </Button>

        {history && (
          <Card className="p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">History ({history.length})</p>
            {history.length === 0 ? (
              <p className="text-xs text-slate-500">No samples in range.</p>
            ) : (
              <div className="max-h-56 space-y-1 overflow-y-auto">
                {history.slice(-50).reverse().map((v, i) => (
                  <div key={i} className="flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-white/5">
                    <span className="text-slate-500">{v.timestamp ? new Date(v.timestamp).toLocaleString() : '—'}</span>
                    <span className="mono text-slate-200">
                      {typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        {node.meta && (
          <Card className="p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Metadata</p>
            <JsonView data={node.meta} />
          </Card>
        )}
      </div>
    </aside>
  );
}
