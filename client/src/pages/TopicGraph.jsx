import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Share2, X, Gauge, Clock, Hash, Send, ListTree, Search, Copy, Trash2, Boxes, Box, Tag, Waypoints, Loader2, Cpu, GitCompareArrows } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { useStore, onMessageActivity } from '@/store/store';
import { api } from '@/lib/api';
import ForceGraph from '@/graph/ForceGraph';

// Heavy renderers load on demand: three.js (3D view) and the WebGL big-graph
// renderer aren't part of the initial bundle — most sessions never open them.
const ForceGraph3D = lazy(() => import('@/graph/ForceGraph3D'));
const WebGLGraph = lazy(() => import('@/graph/WebGLGraph'));

function RendererLoading() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-slate-500">
      <Loader2 size={14} className="mr-2 animate-spin" /> Loading renderer…
    </div>
  );
}
import { buildMqttGraph, collapseGraph } from '@/graph/buildGraph';
import GraphToolbar from '@/components/GraphToolbar';
import GraphSearch from '@/components/GraphSearch';
import ReplayScrubber from '@/components/ReplayScrubber';
import TopicTree from '@/components/TopicTree';
import JsonView from '@/components/JsonView';
import { downloadDataUrl, downloadJson } from '@/lib/download';
import { diffPayloads, formatDiffValue } from '@/lib/payloadDiff';
import { Card, Button, Badge, EmptyState, Input } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import ViewTab from '@/components/ViewTab';
import { formatDistanceToNow } from 'date-fns';

function numericFromPayload(payload) {
  if (typeof payload === 'number') return payload;
  if (typeof payload === 'string') {
    const n = Number(payload);
    return Number.isFinite(n) ? n : null;
  }
  if (payload && typeof payload === 'object') {
    for (const key of ['value', 'v', 'val', 'temperature', 'temp']) {
      if (Number.isFinite(payload[key])) return payload[key];
    }
  }
  return null;
}

function shortText(payload) {
  if (payload == null) return '';
  if (typeof payload === 'object') return JSON.stringify(payload);
  return String(payload);
}

export default function TopicGraph() {
  const brokers = useStore((s) => s.brokers);
  const dataTick = useStore((s) => s.dataTick);
  const topicVersionMap = useStore((s) => s.topicVersion);
  const graphStyle = useStore((s) => s.graphStyle);
  const graphLayout = useStore((s) => s.graphLayout);
  const setGraphLayout = useStore((s) => s.setGraphLayout);
  const coverage = useStore((s) => s.coverage);
  const setCoverage = useStore((s) => s.setCoverage);
  const flowEnabled = useStore((s) => s.flowEnabled);
  const activitySize = useStore((s) => s.activitySize);
  const showValues = useStore((s) => s.showValues);
  const showMinimap = useStore((s) => s.showMinimap);
  const setTopics = useStore((s) => s.setTopics);

  const [brokerId, setBrokerId] = useState(null);
  const [spHosts, setSpHosts] = useState([]); // Sparkplug host applications (spBv1.0/STATE/*)
  const [selected, setSelected] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [matchIds, setMatchIds] = useState(null);
  const [view, setView] = useState('graph'); // 'graph' | 'tree'
  const [treeFilter, setTreeFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [labelDensity, setLabelDensity] = useState(0.5); // 0 (off) .. 1 (dense)
  const [forcePositions, setForcePositions] = useState(null); // worker-computed force coords for show-all
  const [forceBusy, setForceBusy] = useState(false);
  const FORCE_MAX = 30000; // force-layout worker node cap
  const graphRef = useRef(null);

  // Select a topic from the tree, shaping it like a graph node so the shared
  // detail panel works for both views.
  const selectTopic = useCallback(
    (c) =>
      setSelected({
        id: `topic:${brokerId}:${c.path}`,
        label: c.name,
        kind: 'topic',
        meta: {
          fullTopic: c.path,
          isLeaf: true,
          messageCount: c.stat?.messageCount,
          type: c.stat?.type,
          lastActivity: c.stat?.lastActivity
        }
      }),
    [brokerId]
  );

  const connected = brokers.filter((b) => b.status === 'connected');

  // Default to the first connected broker
  useEffect(() => {
    if (!brokerId && connected.length) setBrokerId(connected[0].id);
    if (brokerId && !brokers.some((b) => b.id === brokerId)) setBrokerId(connected[0]?.id || null);
  }, [connected, brokerId, brokers]);

  // Pull the authoritative topic list when broker changes
  useEffect(() => {
    if (!brokerId) return;
    api
      .brokerTopics(brokerId)
      .then((res) => setTopics(brokerId, res.topics))
      .catch(() => {});
  }, [brokerId, setTopics]);

  // Sparkplug host applications (spBv1.0/STATE/*) — polled from the topology
  // snapshot; the strip only shows when the broker actually carries host STATE.
  useEffect(() => {
    if (!brokerId) {
      setSpHosts([]);
      return;
    }
    let alive = true;
    const load = () =>
      api
        .brokerSparkplug(brokerId)
        .then((res) => alive && setSpHosts(res.hosts || []))
        .catch(() => alive && setSpHosts([]));
    load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [brokerId]);

  const broker = brokers.find((b) => b.id === brokerId);
  const topicVersion = topicVersionMap[brokerId] || 0;

  // Read the topic list from the non-reactive index; recompute only when the
  // topic SET changes (topicVersion), not on every message.
  const brokerTopics = useMemo(
    () => useStore.getState().getTopics(brokerId),
    [brokerId, topicVersion]
  );

  const GRAPH_MAX_NODES = 2500;
  const fullGraph = useMemo(() => {
    if (!broker) return { nodes: [], links: [] };
    return buildMqttGraph(broker, brokerTopics, { maxNodes: showAll ? Infinity : GRAPH_MAX_NODES });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broker?.id, brokerTopics, showAll]);

  // Apply collapsed subtrees. Keyed on the collapsed set so toggling re-filters.
  const collapseKey = [...collapsed].sort().join('|');
  const graph = useMemo(
    () => collapseGraph(fullGraph, collapsed),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fullGraph, collapseKey]
  );

  // "Show coverage on topic map" from the Flows view: jump to the graph so the
  // painted trail is immediately visible.
  useEffect(() => {
    if (coverage?.brokerId === brokerId) setView('graph');
  }, [coverage, brokerId]);

  // A batch force layout is a snapshot for a specific node set — drop it
  // when the graph changes (new topics, collapse) so stale coordinates aren't
  // applied to different nodes; the view falls back to the radial layout.
  useEffect(() => {
    setForcePositions(null);
  }, [graph]);

  // Big-graph force layout, computed off the main thread in a Web Worker so the
  // UI stays responsive. The worker is spawned per run and terminated after it
  // posts back positions.
  const runForceLayout = useCallback(() => {
    if (graph.nodes.length > FORCE_MAX) {
      toast.error(`Force layout supports up to ${FORCE_MAX.toLocaleString()} nodes (this has ${graph.nodes.length.toLocaleString()}).`);
      return;
    }
    setForceBusy(true);
    const t = toast.loading('Computing force layout…');
    const worker = new Worker(new URL('../graph/forceLayoutWorker.js', import.meta.url), { type: 'module' });
    const finish = () => {
      worker.terminate();
      setForceBusy(false);
    };
    worker.onmessage = (e) => {
      const { positions, count, error } = e.data || {};
      if (error || !positions) {
        toast.error(error || 'Layout failed', { id: t });
      } else {
        setForcePositions(positions);
        toast.success(`Force layout: ${count.toLocaleString()} nodes`, { id: t });
      }
      finish();
    };
    worker.onerror = () => {
      toast.error('Layout failed', { id: t });
      finish();
    };
    worker.postMessage({
      nodes: graph.nodes.map((n) => ({ id: n.id })),
      links: graph.links.map((l) => ({ source: l.source, target: l.target }))
    });
  }, [graph]);

  // Live buffer snapshot, refreshed at the throttled tick (not per message).
  const liveMsgs = useMemo(
    () => useStore.getState().getLiveMessages(brokerId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [brokerId, dataTick]
  );

  // Latest value + numeric sparkline per leaf topic, for the on-node overlay.
  const nodeValues = useMemo(() => {
    if (!brokerId) return null;
    const byTopic = new Map();
    for (const m of liveMsgs) {
      if (!byTopic.has(m.topic)) byTopic.set(m.topic, []);
      byTopic.get(m.topic).push(m);
    }
    const out = {};
    for (const [topic, msgs] of byTopic) {
      const ordered = msgs.slice().reverse(); // oldest→newest
      const series = ordered.map((m) => numericFromPayload(m.payload)).filter((v) => v != null);
      out[`topic:${brokerId}:${topic}`] = { text: shortText(msgs[0].payload), series: series.slice(-24) };
    }
    return out;
  }, [brokerId, liveMsgs]);

  // Feed live message activity to the graph's flow animation. Maps an incoming
  // message on this broker to its leaf node id (see buildMqttGraph node ids).
  const activitySource = useCallback(
    (pulse) =>
      onMessageActivity((msg) => {
        if (msg.brokerId !== brokerId) return;
        pulse(`topic:${brokerId}:${msg.topic}`);
      }),
    [brokerId]
  );

  // Double-click a branch node to collapse/expand its subtree.
  const toggleCollapse = useCallback((node) => {
    if (!node || node.meta?.isLeaf) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }, []);

  const replayNodeId = useCallback((m) => `topic:${brokerId}:${m.topic}`, [brokerId]);

  // Frame the whole network when Show all is toggled on.
  useEffect(() => {
    if (showAll) {
      const t = setTimeout(() => graphRef.current?.fitTo(), 250);
      return () => clearTimeout(t);
    }
  }, [showAll]);

  if (connected.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Topic Graph" subtitle="Interactive node graph of the MQTT topic namespace" />
        <EmptyState
          icon={Share2}
          title="No connected brokers"
          hint="Connect to an MQTT broker to visualize its live topic tree as a node graph."
          action={
            <Link to="/brokers">
              <Button>Connect a broker</Button>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Topics"
        subtitle={broker ? `${brokerTopics.length} topics · ${graph.nodes.length} nodes` : 'Select a broker'}
        actions={
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-xl border border-white/10">
              <ViewTab active={view === 'graph'} onClick={() => setView('graph')} icon={Share2} label="Graph" />
              <ViewTab active={view === '3d'} onClick={() => setView('3d')} icon={Box} label="3D" />
              <ViewTab active={view === 'tree'} onClick={() => setView('tree')} icon={ListTree} label="Tree" />
            </div>
            <select
              value={brokerId || ''}
              onChange={(e) => {
                setBrokerId(e.target.value);
                setSelected(null);
              }}
              className="rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-200 focus:border-accent-500/60 focus:outline-none"
            >
              {connected.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        }
      />

      {spHosts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/5 bg-surface-900/40 px-4 py-2">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            <Cpu size={12} className="text-accent-400" /> Host applications
          </span>
          {spHosts.map((h) => (
            <span
              key={h.id}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-surface-950/60 px-2 py-1 text-[11px]"
              title={`spBv1.0/STATE/${h.id}`}
            >
              <span className={clsx('h-1.5 w-1.5 rounded-full', h.online ? 'bg-emerald-400' : h.online === false ? 'bg-rose-400' : 'bg-slate-500')} />
              <span className="font-mono text-slate-200">{h.id}</span>
              <Badge status={h.online ? 'connected' : 'offline'}>{h.online ? 'online' : h.online === false ? 'offline' : 'unknown'}</Badge>
              {(h.timestamp || h.lastSeen) && (
                <span className="text-slate-500">
                  {formatDistanceToNow(new Date(h.timestamp || h.lastSeen), { addSuffix: true })}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="relative flex flex-1 overflow-hidden">
        {view === 'tree' ? (
          <div className="flex w-full max-w-md flex-col border-r border-white/5 bg-surface-900/30">
            <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2">
              <Search size={14} className="text-slate-500" />
              <input
                value={treeFilter}
                onChange={(e) => setTreeFilter(e.target.value)}
                placeholder="Filter topics…"
                className="w-full bg-transparent text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none"
              />
            </div>
            <TopicTree
              topics={brokerTopics}
              selectedTopic={selected?.meta?.fullTopic}
              onSelect={selectTopic}
              filter={treeFilter}
            />
          </div>
        ) : view === '3d' ? (
          <div className="relative flex-1">
            <Suspense fallback={<RendererLoading />}>
              <ForceGraph3D data={graph} styleId={graphStyle} selectedId={selected?.id || null} onSelect={setSelected} />
            </Suspense>
            <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-[11px] text-slate-500 backdrop-blur">
              Drag to rotate · scroll to zoom · click a node for details
            </div>
          </div>
        ) : (
          <div className="relative flex-1">
            {!showAll && (
              <>
                <GraphSearch nodes={graph.nodes} onMatches={setMatchIds} onFit={(ids) => graphRef.current?.fitTo(ids)} />
                <GraphToolbar
                  showFlow
                  onFit={() => graphRef.current?.fitTo()}
                  onBeautify={() => setGraphLayout('radial')}
                  onExportPng={() => downloadDataUrl(graphRef.current?.exportPng(), `topic-graph-${brokerId}.png`)}
                  onExportJson={() => downloadJson(graphRef.current?.exportGraph(), `topic-graph-${brokerId}.json`)}
                />
              </>
            )}
            {showAll ? (
              // GPU renderer for the "show everything" view — one draw call per
              // frame plus a viewport-culled label overlay stays smooth at 60k+.
              <Suspense fallback={<RendererLoading />}>
                <WebGLGraph data={graph} styleId={graphStyle} selectedId={selected?.id || null} onSelect={setSelected} labelDensity={labelDensity} positions={forcePositions} />
              </Suspense>
            ) : (
              <ForceGraph
                ref={graphRef}
                data={graph}
                styleId={graphStyle}
                layoutId={graphLayout}
                selectedId={selected?.id || null}
                onSelect={setSelected}
                onExpand={toggleCollapse}
                flow={flowEnabled}
                activitySource={activitySource}
                activitySize={activitySize}
                nodeValues={showValues ? nodeValues : null}
                matchIds={coverage?.brokerId === brokerId ? coverage.matchIds : matchIds}
                minimap={showMinimap}
              />
            )}
            {coverage?.brokerId === brokerId && !showAll && (
              // Coverage paint handed over from the Flows view: the highlighted
              // trail is exactly what the chosen client actually receives.
              <div className="absolute left-4 top-4 z-10 flex items-center gap-2 rounded-xl border border-accent-500/50 bg-accent-500/15 px-3 py-2 text-[11px] text-accent-200 backdrop-blur">
                <span>{coverage.label}</span>
                <button onClick={() => setCoverage(null)} title="Clear coverage highlight" className="rounded p-0.5 hover:bg-white/10">
                  <X size={12} />
                </button>
              </div>
            )}
            {(graph.capped || showAll) && (
              <div className="absolute left-4 top-16 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setShowAll((v) => !v)}
                  className={clsx(
                    'flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[11px] backdrop-blur transition',
                    showAll
                      ? 'border-accent-500/60 bg-accent-500/15 text-accent-200'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
                  )}
                >
                  <Boxes size={13} />
                  {showAll
                    ? `Showing all ${graph.nodes.length.toLocaleString()} nodes`
                    : `Show all ${brokerTopics.length.toLocaleString()} topics as nodes`}
                </button>

                {/* One unified control cluster for the big-graph view */}
                {showAll && (
                  <div className="flex items-stretch divide-x divide-white/10 overflow-hidden rounded-xl border border-white/10 bg-surface-900/80 text-[11px] backdrop-blur">
                    <Segment>
                      <SegLabel>Layout</SegLabel>
                      <SegBtn active={!forcePositions} onClick={() => setForcePositions(null)} title="Deterministic radial layout">
                        Radial
                      </SegBtn>
                      <SegBtn
                        active={Boolean(forcePositions)}
                        onClick={runForceLayout}
                        disabled={forceBusy || graph.nodes.length > FORCE_MAX}
                        title={
                          graph.nodes.length > FORCE_MAX
                            ? `Force layout supports up to ${FORCE_MAX.toLocaleString()} nodes`
                            : 'Organic force-directed layout (computed in a Web Worker)'
                        }
                      >
                        {forceBusy ? <Loader2 size={12} className="animate-spin" /> : <Waypoints size={12} />}
                        Force
                      </SegBtn>
                    </Segment>

                    <Segment>
                      <SegLabel>
                        <Tag size={11} /> Labels
                      </SegLabel>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={labelDensity}
                        onChange={(e) => setLabelDensity(Number(e.target.value))}
                        className="h-1 w-20 cursor-pointer accent-accent-400"
                        title="Label density"
                      />
                      <span className="w-7 tabular-nums text-slate-500">{labelDensity <= 0.001 ? 'off' : `${Math.round(labelDensity * 100)}%`}</span>
                    </Segment>
                  </div>
                )}
                {showAll && graph.nodes.length > 60000 && (
                  <span className="rounded-lg bg-surface-900/70 px-2 py-1 text-[10px] text-slate-500 backdrop-blur">heavy — zoom in for detail</span>
                )}
              </div>
            )}
            <div className="pointer-events-none absolute bottom-4 left-4 flex flex-col gap-2">
              {!showAll && (
                <div className="pointer-events-auto">
                  <ReplayScrubber messages={liveMsgs} toNodeId={replayNodeId} graphRef={graphRef} />
                </div>
              )}
              <div className="rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-[11px] text-slate-500 backdrop-blur">
                Drag · scroll to zoom · click for details · double-click a branch to collapse · messages animate live
              </div>
            </div>
          </div>
        )}

        {selected && (
          <TopicPanel
            node={selected}
            brokerId={brokerId}
            messages={liveMsgs}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}


// Segmented-toolbar primitives for the unified big-graph control cluster.
function Segment({ children }) {
  return <div className="flex items-center gap-1.5 px-2 py-1.5">{children}</div>;
}
function SegLabel({ children }) {
  return <span className="flex items-center gap-1 pr-0.5 text-[10px] uppercase tracking-wide text-slate-500">{children}</span>;
}
function SegBtn({ active, onClick, disabled, title, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx(
        'flex items-center gap-1 rounded-md px-2 py-1 transition disabled:cursor-not-allowed disabled:opacity-40',
        active ? 'bg-accent-500/20 text-accent-200' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
      )}
    >
      {children}
    </button>
  );
}

function TopicPanel({ node, brokerId, messages, onClose }) {
  const meta = node.meta || {};
  const fullTopic = meta.fullTopic;
  const [history, setHistory] = useState([]);
  const [publishValue, setPublishValue] = useState('');
  const [qos, setQos] = useState(0);
  const [retain, setRetain] = useState(false);
  const [diffSel, setDiffSel] = useState([]); // up to two message ids for payload diff

  useEffect(() => {
    if (!fullTopic) return;
    api
      .topicMessages(brokerId, fullTopic, 30)
      .then((res) => setHistory(res.messages.slice().reverse()))
      .catch(() => setHistory([]));
  }, [brokerId, fullTopic]);

  // Merge in live messages for this exact topic
  const live = messages.filter((m) => m.topic === fullTopic);
  const merged = [...live, ...history.filter((h) => !live.some((l) => l.id === h.id))].slice(0, 40);
  const latest = merged[0];

  const publish = async () => {
    try {
      await api.publish(brokerId, fullTopic, publishValue, { qos, retain });
      toast.success(retain ? 'Published (retained)' : 'Published');
      setPublishValue('');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const deleteRetained = async () => {
    // This publishes an empty retained message to the LIVE broker — every other
    // consumer of this topic loses its retained value (device configs, Sparkplug
    // STATE, last-known values). Confirm the exact topic first.
    if (!window.confirm(`Clear the retained message on "${fullTopic}"?\n\nThis publishes an empty retained payload to the broker. Every other client subscribed to this topic will lose its retained value.`)) {
      return;
    }
    try {
      await api.publish(brokerId, fullTopic, '', { retain: true });
      toast.success('Cleared retained message');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const copy = (text) => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success('Copied'),
      () => toast.error('Copy failed')
    );
  };

  const numericSeries = merged
    .slice()
    .reverse()
    .map((m) => numericFromPayload(m.payload))
    .filter((v) => v != null);

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-white/5 bg-surface-900/50">
      <div className="flex items-start justify-between gap-2 border-b border-white/5 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-slate-500">
            {meta.isLeaf ? 'Topic' : node.kind === 'broker' ? 'Broker' : 'Topic branch'}
          </p>
          <div className="flex items-center gap-1.5">
            <p className="mono mt-0.5 break-all text-sm font-medium text-slate-100">{fullTopic || node.label}</p>
            {fullTopic && (
              <button onClick={() => copy(fullTopic)} title="Copy topic" className="shrink-0 text-slate-500 hover:text-slate-300">
                <Copy size={13} />
              </button>
            )}
          </div>
        </div>
        <button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-300">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {meta.isLeaf && (
          <div className="grid grid-cols-3 gap-2">
            <Stat icon={Hash} label="Messages" value={meta.messageCount ?? '—'} />
            <Stat icon={Gauge} label="Type" value={<Badge>{meta.type}</Badge>} />
            <Stat
              icon={Clock}
              label="Last seen"
              value={meta.lastActivity ? formatDistanceToNow(new Date(meta.lastActivity), { addSuffix: true }) : '—'}
            />
          </div>
        )}

        {latest && (
          <Card className="p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Latest payload</p>
              <button
                onClick={() =>
                  copy(typeof latest.payload === 'object' ? JSON.stringify(latest.payload) : String(latest.payload))
                }
                title="Copy value"
                className="text-slate-500 hover:text-slate-300"
              >
                <Copy size={13} />
              </button>
            </div>
            {latest.sparkplug ? (
              <JsonView data={latest.sparkplug} name="sparkplug" />
            ) : typeof latest.payload === 'object' ? (
              <JsonView data={latest.payload} />
            ) : (
              <pre className="mono max-h-56 overflow-auto whitespace-pre-wrap break-all text-xs text-emerald-300">
                {String(latest.payload)}
              </pre>
            )}
            {numericSeries.length > 3 && <PanelPlot series={numericSeries} />}
          </Card>
        )}

        {meta.isLeaf && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Publish</p>
              <div className="flex items-center gap-2">
                <select
                  value={qos}
                  onChange={(e) => setQos(Number(e.target.value))}
                  className="rounded-md border border-white/10 bg-surface-950/60 px-1.5 py-0.5 text-[11px] text-slate-300"
                  title="QoS"
                >
                  <option value={0}>QoS 0</option>
                  <option value={1}>QoS 1</option>
                  <option value={2}>QoS 2</option>
                </select>
                <label className="flex items-center gap-1 text-[11px] text-slate-400">
                  <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} /> retain
                </label>
              </div>
            </div>
            <div className="flex gap-2">
              <Input
                value={publishValue}
                onChange={(e) => setPublishValue(e.target.value)}
                placeholder="Payload…"
                onKeyDown={(e) => e.key === 'Enter' && publish()}
              />
              <Button onClick={publish} disabled={!publishValue}>
                <Send size={14} />
              </Button>
            </div>
            <button
              onClick={deleteRetained}
              className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-rose-300"
            >
              <Trash2 size={12} /> Clear retained message
            </button>
          </div>
        )}

        {merged.length > 0 && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                History ({merged.length})
              </p>
              <span className="text-[10px] text-slate-600">
                {diffSel.length === 0 ? 'pick two to diff' : diffSel.length === 1 ? 'pick one more' : ''}
              </span>
            </div>
            <PayloadDiffCard messages={merged} sel={diffSel} onClear={() => setDiffSel([])} />
            <div className="space-y-1">
              {merged.map((m) => {
                const inDiff = diffSel.includes(m.id);
                return (
                  <div
                    key={m.id}
                    className={clsx(
                      'rounded-lg border px-2.5 py-1.5',
                      inDiff ? 'border-accent-500/40 bg-accent-500/10' : 'border-white/5 bg-white/[0.02]'
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-500">
                        {new Date(m.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="text-[11px] text-slate-600">QoS {m.qos}</span>
                        <button
                          title={inDiff ? 'Remove from diff' : 'Select for diff'}
                          onClick={() =>
                            setDiffSel((prev) =>
                              prev.includes(m.id) ? prev.filter((id) => id !== m.id) : [...prev.slice(-1), m.id]
                            )
                          }
                          className={clsx('rounded p-0.5', inDiff ? 'text-accent-300' : 'text-slate-600 hover:text-slate-300')}
                        >
                          <GitCompareArrows size={12} />
                        </button>
                      </span>
                    </div>
                    <p className="mono mt-0.5 truncate text-xs text-slate-300">
                      {typeof m.payload === 'object' ? JSON.stringify(m.payload) : String(m.payload)}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

// Structural diff of two selected history messages (older → newer). Shows what
// actually changed between publishes — the fastest way to spot a misbehaving
// field in a fat JSON payload.
function PayloadDiffCard({ messages, sel, onClear }) {
  if (sel.length !== 2) return null;
  const pair = messages.filter((m) => sel.includes(m.id));
  if (pair.length !== 2) return null;
  const [older, newer] = pair.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const changes = diffPayloads(older.payload, newer.payload);
  const KIND_CLASS = { added: 'text-emerald-300', removed: 'text-rose-300', changed: 'text-amber-300' };
  return (
    <Card className="mb-2 p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          <GitCompareArrows size={12} className="text-accent-300" /> Payload diff
        </span>
        <span className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500">
            {new Date(older.timestamp).toLocaleTimeString()} → {new Date(newer.timestamp).toLocaleTimeString()}
          </span>
          <button onClick={onClear} className="text-slate-500 hover:text-slate-300">
            <X size={12} />
          </button>
        </span>
      </div>
      {changes.length === 0 ? (
        <p className="text-[11px] text-slate-500">Payloads are identical.</p>
      ) : (
        <div className="max-h-48 space-y-0.5 overflow-y-auto font-mono text-[11px]">
          {changes.slice(0, 100).map((c, i) => (
            <div key={i} className="flex items-baseline gap-1.5">
              <span className={`shrink-0 ${KIND_CLASS[c.kind]}`}>{c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '±'}</span>
              <span className="shrink-0 text-slate-400">{c.path}</span>
              <span className="truncate text-slate-500">
                {c.kind === 'added'
                  ? formatDiffValue(c.to)
                  : c.kind === 'removed'
                    ? formatDiffValue(c.from)
                    : `${formatDiffValue(c.from)} → ${formatDiffValue(c.to)}`}
              </span>
            </div>
          ))}
          {changes.length > 100 && <p className="text-slate-500">…{changes.length - 100} more changes</p>}
        </div>
      )}
    </Card>
  );
}

function Stat({ icon: Icon, label, value }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-2.5">
      <Icon size={14} className="text-slate-500" />
      <p className="mt-1.5 text-sm font-medium text-slate-200">{value}</p>
      <p className="text-[11px] text-slate-500">{label}</p>
    </div>
  );
}

// Numeric history plot for the detail panel.
function PanelPlot({ series }) {
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const w = 320;
  const h = 70;
  const pts = series
    .map((v, i) => `${(i / (series.length - 1)) * w},${h - ((v - min) / span) * h}`)
    .join(' ');
  return (
    <div className="mt-3 rounded-lg border border-white/5 bg-surface-950/50 p-2">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-20 w-full" preserveAspectRatio="none">
        <polyline points={pts} fill="none" stroke="#38bdf8" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-slate-500">
        <span>min {min}</span>
        <span>{series.length} pts</span>
        <span>max {max}</span>
      </div>
    </div>
  );
}
