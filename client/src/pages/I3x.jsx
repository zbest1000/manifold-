import { useEffect, useMemo, useState } from 'react';
import { Boxes, Plug, LogOut, X, Activity, Layers } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import ForceGraph from '@/graph/ForceGraph';
import { buildI3xGraph } from '@/graph/buildGraph';
import GraphToolbar from '@/components/GraphToolbar';
import JsonView from '@/components/JsonView';
import { useStore } from '@/store/store';
import { Card, Button, Badge, Input, Field, EmptyState } from '@/components/ui';
import PageHeader from '@/components/PageHeader';

export default function I3x() {
  const graphStyle = useStore((s) => s.graphStyle);
  const graphLayout = useStore((s) => s.graphLayout);

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
  const graph = useMemo(() => {
    if (!connected) return { nodes: [], links: [] };
    return buildI3xGraph(server, objects);
  }, [connected, server, objects]);

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
            <Badge status="connected">i3X {server.info?.specVersion || ''}</Badge>
            <Button variant="outline" onClick={disconnect}>
              <LogOut size={15} /> Disconnect
            </Button>
          </div>
        }
      />

      <div className="relative flex flex-1 overflow-hidden">
        <div className="relative flex-1">
          {objects.length === 0 ? (
            <EmptyState icon={Layers} title="No objects returned" hint="This i3X server exposed no objects." />
          ) : (
            <>
              <GraphToolbar />
              <ForceGraph
                data={graph}
                styleId={graphStyle}
                layoutId={graphLayout}
                selectedId={selected?.id || null}
                onSelect={setSelected}
              />
              <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-[11px] text-slate-500 backdrop-blur">
                Object graph · click a node to read its value and history
              </div>
            </>
          )}
        </div>

        {selected && selected.kind === 'i3x-object' && (
          <ObjectPanel node={selected} onClose={() => setSelected(null)} />
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
