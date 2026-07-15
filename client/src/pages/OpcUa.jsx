import { useEffect, useMemo, useRef, useState } from 'react';
import { Cpu, Plus, X, Activity, Eye, ListTree, Search, Share2, Box } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import { socket } from '@/lib/socket';
import ForceGraph from '@/graph/ForceGraph';
import ForceGraph3D from '@/graph/ForceGraph3D';
import { buildOpcuaGraph } from '@/graph/buildGraph';
import GraphToolbar from '@/components/GraphToolbar';
import GraphSearch from '@/components/GraphSearch';
import GraphTree from '@/components/GraphTree';
import JsonView from '@/components/JsonView';
import { downloadDataUrl, downloadJson } from '@/lib/download';
import { Card, Button, Badge, Input, Field, EmptyState } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import ViewTab from '@/components/ViewTab';


const ROOT = 'ns=0;i=84';

export default function OpcUa() {
  const opcua = useStore((s) => s.opcua);
  const opcuaValues = useStore((s) => s.opcuaValues);
  const setOpcua = useStore((s) => s.setOpcua);
  const graphStyle = useStore((s) => s.graphStyle);
  const showValues = useStore((s) => s.showValues);
  const showMinimap = useStore((s) => s.showMinimap);

  // OPC UA address spaces are strictly hierarchical — default to the client
  // `tree` layout (kept per-view so it doesn't override the MQTT graph's pref).
  const [graphLayout, setGraphLayout] = useState('tree');
  const [connectionId, setConnectionId] = useState(null);
  const [expanded, setExpanded] = useState(new Map()); // nodeId -> references
  const [selected, setSelected] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', endpointUrl: 'opc.tcp://localhost:4840' });
  const [busy, setBusy] = useState(false);
  const [matchIds, setMatchIds] = useState(null);
  const [view, setView] = useState('graph');
  const [treeFilter, setTreeFilter] = useState('');
  const graphRef = useRef(null);

  const connected = opcua.filter((c) => c.status === 'connected');

  useEffect(() => {
    if (!connectionId && connected.length) setConnectionId(connected[0].id);
    if (connectionId && !opcua.some((c) => c.id === connectionId)) setConnectionId(connected[0]?.id || null);
  }, [connected, connectionId, opcua]);

  // Load root children whenever the active connection changes
  useEffect(() => {
    if (!connectionId) return;
    setExpanded(new Map());
    setSelected(null);
    api
      .opcuaBrowse(connectionId, ROOT)
      .then((res) => setExpanded(new Map([[ROOT, res.references]])))
      .catch((e) => toast.error(e.message));
  }, [connectionId]);

  const connection = opcua.find((c) => c.id === connectionId);
  const graph = useMemo(() => {
    if (!connection) return { nodes: [], links: [] };
    return buildOpcuaGraph(connection, expanded);
  }, [connection, expanded]);

  // Latest monitored value per node, for the on-node overlay.
  const nodeValues = useMemo(() => {
    const vals = opcuaValues[connectionId] || {};
    const out = {};
    for (const [nodeId, v] of Object.entries(vals)) {
      out[`opcua:${connectionId}:${nodeId}`] = {
        text: typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value)
      };
    }
    return out;
  }, [connectionId, opcuaValues]);

  const connect = async () => {
    if (!form.endpointUrl) return toast.error('Endpoint URL is required');
    setBusy(true);
    try {
      const res = await api.connectOpcua(form);
      toast.success('Connected to OPC UA server');
      setShowForm(false);
      setConnectionId(res.connectionId);
      const list = await api.listOpcua();
      setOpcua(list.connections);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const expandNode = async (node) => {
    const nodeId = node.meta?.nodeId;
    if (!nodeId || expanded.has(nodeId)) return;
    try {
      const res = await api.opcuaBrowse(connectionId, nodeId);
      setExpanded((prev) => new Map(prev).set(nodeId, res.references));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const disconnect = async (id) => {
    try {
      await api.disconnectOpcua(id);
      const list = await api.listOpcua();
      setOpcua(list.connections);
      toast.success('Disconnected');
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (opcua.length === 0 && !showForm) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="OPC UA"
          subtitle="Browse an OPC UA address space as a node graph and watch live values"
          actions={
            <Button onClick={() => setShowForm(true)}>
              <Plus size={15} /> Connect server
            </Button>
          }
        />
        <EmptyState
          icon={Cpu}
          title="No OPC UA servers"
          hint="Connect to an OPC UA endpoint (opc.tcp://…) to explore its address space."
          action={<Button onClick={() => setShowForm(true)}>Connect server</Button>}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="OPC UA"
        subtitle={connection ? `${graph.nodes.length} nodes · double-click to expand` : 'Connect an endpoint'}
        actions={
          <div className="flex items-center gap-2">
            {connection && (
              <div className="flex overflow-hidden rounded-xl border border-white/10">
                <ViewTab active={view === 'graph'} onClick={() => setView('graph')} icon={Share2} label="Graph" />
                <ViewTab active={view === '3d'} onClick={() => setView('3d')} icon={Box} label="3D" />
                <ViewTab active={view === 'tree'} onClick={() => setView('tree')} icon={ListTree} label="Tree" />
              </div>
            )}
            {connected.length > 0 && (
              <select
                value={connectionId || ''}
                onChange={(e) => setConnectionId(e.target.value)}
                className="rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-200 focus:border-accent-500/60 focus:outline-none"
              >
                {connected.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <Button variant="outline" onClick={() => setShowForm((v) => !v)}>
              <Plus size={15} /> Connect
            </Button>
          </div>
        }
      />

      {showForm && (
        <Card className="mx-6 mt-4 p-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="PLC gateway" />
            </Field>
            <Field label="Endpoint URL">
              <Input value={form.endpointUrl} onChange={(e) => setForm({ ...form, endpointUrl: e.target.value })} />
            </Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
            <Button onClick={connect} disabled={busy}>
              <Cpu size={15} /> Connect
            </Button>
          </div>
        </Card>
      )}

      <div className="relative flex flex-1 overflow-hidden">
        <div className="relative flex-1">
          {connection ? (
            view === 'tree' ? (
              <div className="flex h-full w-full max-w-md flex-col border-r border-white/5 bg-surface-900/30">
                <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2">
                  <Search size={14} className="text-slate-500" />
                  <input
                    value={treeFilter}
                    onChange={(e) => setTreeFilter(e.target.value)}
                    placeholder="Filter nodes…"
                    className="w-full bg-transparent text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none"
                  />
                </div>
                <GraphTree
                  nodes={graph.nodes}
                  links={graph.links}
                  selectedId={selected?.id || null}
                  onSelect={setSelected}
                  onExpandNode={expandNode}
                  valueMap={showValues ? nodeValues : null}
                  filter={treeFilter}
                />
              </div>
            ) : view === '3d' ? (
              <>
                <ForceGraph3D data={graph} styleId={graphStyle} selectedId={selected?.id || null} onSelect={setSelected} />
                <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-[11px] text-slate-500 backdrop-blur">
                  Drag to rotate · scroll to zoom · click a node for details
                </div>
              </>
            ) : (
              <>
                <GraphSearch nodes={graph.nodes} onMatches={setMatchIds} onFit={(ids) => graphRef.current?.fitTo(ids)} />
                <GraphToolbar
                  onFit={() => graphRef.current?.fitTo()}
                  onExportPng={() => downloadDataUrl(graphRef.current?.exportPng(), `opcua-graph-${connectionId}.png`)}
                  onExportJson={() => downloadJson(graphRef.current?.exportGraph(), `opcua-graph-${connectionId}.json`)}
                  layoutValue={graphLayout}
                  onLayoutChange={setGraphLayout}
                />
                <ForceGraph
                  ref={graphRef}
                  data={graph}
                  styleId={graphStyle}
                  layoutId={graphLayout}
                  selectedId={selected?.id || null}
                  onSelect={setSelected}
                  onExpand={expandNode}
                  nodeValues={showValues ? nodeValues : null}
                  matchIds={matchIds}
                  minimap={showMinimap}
                />
                <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-[11px] text-slate-500 backdrop-blur">
                  Double-click a node to browse its children · click to inspect
                </div>
              </>
            )
          ) : (
            <EmptyState icon={Cpu} title="No connected server selected" hint="Connect an endpoint above." />
          )}
        </div>

        {selected && (
          <NodePanel
            node={selected}
            connectionId={connectionId}
            values={opcuaValues[connectionId] || {}}
            onClose={() => setSelected(null)}
            onDisconnect={disconnect}
          />
        )}
      </div>
    </div>
  );
}

function NodePanel({ node, connectionId, values, onClose }) {
  const nodeId = node.meta?.nodeId;
  const [details, setDetails] = useState(null);
  const [monitoring, setMonitoring] = useState(false);

  useEffect(() => {
    if (!nodeId) return;
    setDetails(null);
    api.opcuaRead(connectionId, nodeId).then(setDetails).catch(() => setDetails(null));
  }, [connectionId, nodeId]);

  const liveValue = values[nodeId];

  const monitor = async () => {
    try {
      await api.opcuaMonitor(connectionId, nodeId, 500);
      setMonitoring(true);
      toast.success('Monitoring value');
    } catch (e) {
      toast.error(e.message);
    }
  };

  useEffect(() => {
    return () => {
      if (monitoring) socket.emit('opcua-unmonitor', { connectionId, nodeId });
    };
  }, [monitoring, connectionId, nodeId]);

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-white/5 bg-surface-900/50">
      <div className="flex items-start justify-between gap-2 border-b border-white/5 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-slate-500">{node.meta?.nodeClass || 'Node'}</p>
          <p className="mt-0.5 break-all text-sm font-medium text-slate-100">{node.label}</p>
          <p className="mono mt-0.5 break-all text-[11px] text-slate-500">{nodeId}</p>
        </div>
        <button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-300">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {node.meta?.nodeClass === 'Variable' && (
          <Button onClick={monitor} disabled={monitoring} className="w-full">
            <Eye size={14} /> {monitoring ? 'Monitoring live' : 'Monitor value'}
          </Button>
        )}

        {liveValue && (
          <Card className="border-accent-500/20 p-3">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-accent-400">
              <Activity size={12} /> Live value
            </p>
            <p className="mono break-all text-lg font-semibold text-slate-100">
              {typeof liveValue.value === 'object' ? JSON.stringify(liveValue.value) : String(liveValue.value)}
            </p>
            {liveValue.sourceTimestamp && (
              <p className="mt-1 text-[11px] text-slate-500">
                {new Date(liveValue.sourceTimestamp).toLocaleString()}
              </p>
            )}
          </Card>
        )}

        {details && (
          <Card className="p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Attributes</p>
            <JsonView data={details} />
          </Card>
        )}
      </div>
    </aside>
  );
}
