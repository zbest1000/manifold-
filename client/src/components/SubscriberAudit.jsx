import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Users, Radio, RefreshCw, Trash2, ShieldCheck, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { useStore } from '@/store/store';
import { buildPubSubGraph } from '@/graph/buildGraph';
import ForceGraph from '@/graph/ForceGraph';
import { Card, Badge, Button, Input, Field, EmptyState } from '@/components/ui';

/**
 * Subscriber audit: "who subscribes to what", sourced from a broker admin API
 * (EMQX v5 REST). MQTT / $SYS can't provide this — only the broker's admin API
 * can — so this view is gated on the user supplying admin credentials.
 */
export default function SubscriberAudit({ broker }) {
  const graphStyle = useStore((s) => s.graphStyle);
  const [admin, setAdmin] = useState(null); // { configured, type, url, hasKey }
  const [form, setForm] = useState({ type: 'emqx', url: '', apiKey: '', apiSecret: '' });
  const [data, setData] = useState(null); // { clients, subscriptions, source, truncated }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);

  const refreshConfig = useCallback(async () => {
    if (!broker?.id) return;
    try {
      setAdmin(await api.getBrokerAdmin(broker.id));
    } catch {
      setAdmin({ configured: false });
    }
  }, [broker?.id]);

  useEffect(() => {
    setData(null);
    setError(null);
    setSelected(null);
    refreshConfig();
  }, [broker?.id, refreshConfig]);

  const load = useCallback(async () => {
    if (!broker?.id) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.brokerAdminPubSub(broker.id);
      setData(res);
    } catch (e) {
      setError(e.message || 'Failed to reach broker admin API');
    } finally {
      setBusy(false);
    }
  }, [broker?.id]);

  // Auto-load once we know admin is configured.
  useEffect(() => {
    if (admin?.configured && !data && !busy) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin?.configured]);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setBrokerAdmin(broker.id, form);
      await refreshConfig();
      await load();
    } catch (err) {
      setError(err.message || 'Could not save admin config');
      setBusy(false);
    }
  };

  const reset = async () => {
    await api.clearBrokerAdmin(broker.id);
    setData(null);
    setForm({ type: 'emqx', url: '', apiKey: '', apiSecret: '' });
    refreshConfig();
  };

  const graph = useMemo(
    () => (data && broker ? buildPubSubGraph(broker, data) : { nodes: [], links: [] }),
    [data, broker]
  );
  const selNode = selected ? graph.nodes.find((n) => n.id === selected) : null;

  // --- Not configured: show the connect form ---
  if (!admin?.configured) {
    return (
      <div className="grid h-full place-items-center overflow-y-auto p-8">
        <Card className="w-full max-w-md p-5">
          <div className="mb-1 flex items-center gap-2 text-base font-semibold text-slate-100">
            <ShieldCheck size={18} className="text-accent-400" /> Connect a broker admin API
          </div>
          <p className="mb-4 text-xs leading-relaxed text-slate-400">
            Per-client subscriptions aren&apos;t exposed by MQTT or <code>$SYS</code> — only a broker admin API can reveal them. Point this at an <strong>EMQX v5</strong> REST endpoint (create an API key in the EMQX dashboard) to map who subscribes to what.
          </p>
          <form onSubmit={save} className="space-y-3">
            <Field label="Admin type">
              <select
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200"
              >
                <option value="emqx">EMQX v5 (REST)</option>
              </select>
            </Field>
            <Field label="API base URL">
              <Input
                placeholder="http://broker-host:18083/api/v5"
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                required
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="API key">
                <Input value={form.apiKey} onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))} />
              </Field>
              <Field label="API secret">
                <Input type="password" value={form.apiSecret} onChange={(e) => setForm((f) => ({ ...f, apiSecret: e.target.value }))} />
              </Field>
            </div>
            {error && (
              <p className="flex items-center gap-1.5 text-xs text-rose-300">
                <AlertTriangle size={13} /> {error}
              </p>
            )}
            <Button type="submit" disabled={busy || !form.url} className="w-full">
              {busy ? 'Connecting…' : 'Connect & map subscriptions'}
            </Button>
          </form>
          <p className="mt-3 text-[11px] text-slate-500">
            The API secret is stored server-side only and never sent back to the browser. HiveMQ / <code>mosquitto_ctrl</code> backends can be added behind the same switch.
          </p>
        </Card>
      </div>
    );
  }

  // --- Configured: show the client ↔ topic subscription graph ---
  return (
    <div className="flex h-full w-full">
      <div className="relative flex-1">
        {graph.nodes.length > 1 ? (
          <ForceGraph data={graph} styleId={graphStyle} layoutId="organic" selectedId={selected} onSelect={setSelected} />
        ) : (
          <div className="grid h-full place-items-center p-8">
            <EmptyState
              icon={Users}
              title={error ? 'Admin API error' : busy ? 'Loading subscriptions…' : 'No subscriptions reported'}
              hint={error || 'The broker admin API returned no clients/subscriptions yet.'}
            />
          </div>
        )}
        {graph.nodes.length > 1 && (
          <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-[11px] text-slate-400 backdrop-blur">
            edges = subscriptions · shared topic filters become hubs · click a node for detail
          </div>
        )}
      </div>

      <div className="w-80 shrink-0 space-y-3 overflow-y-auto border-l border-white/5 bg-surface-900/30 p-3">
        <Card className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Radio size={15} className="text-accent-400" /> Subscription map
            </span>
            <span className="flex items-center gap-1">
              <button onClick={load} disabled={busy} title="Refresh" className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 disabled:opacity-40">
                <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
              </button>
              <button onClick={reset} title="Disconnect admin" className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10">
                <Trash2 size={13} />
              </button>
            </span>
          </div>
          <p className="mb-2 flex items-center gap-1.5 text-[11px] text-slate-500">
            <KeyRound size={11} /> {admin.type?.toUpperCase()} · {admin.url}
          </p>
          {data && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Stat label="Clients" value={data.clients?.length} />
              <Stat label="Subscriptions" value={data.subscriptions?.length} />
            </div>
          )}
          {data?.truncated && <p className="mt-2 text-[10px] text-amber-300/80">Result truncated at the safety cap.</p>}
          {error && <p className="mt-2 text-[11px] text-rose-300">{error}</p>}
        </Card>

        {selNode?.meta?.kind === 'client' && (
          <Card className="p-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="truncate text-sm font-semibold text-slate-100">{selNode.label}</span>
              <Badge status={selNode.meta.connected ? 'connected' : 'error'}>{selNode.meta.connected ? 'connected' : 'offline'}</Badge>
            </div>
            <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">mqtt client</p>
            <div className="space-y-1 text-xs text-slate-400">
              {selNode.meta.username && <Row k="Username" v={selNode.meta.username} />}
              {selNode.meta.ip && <Row k="IP" v={selNode.meta.ip} />}
              <Row k="Subscribes to" v={`${subsFor(graph, selNode.id).length} filter(s)`} />
            </div>
            <TopicList topics={subsFor(graph, selNode.id)} />
          </Card>
        )}

        {selNode?.meta?.kind === 'filter' && (
          <Card className="p-3">
            <div className="mb-1 truncate text-sm font-semibold text-slate-100">{selNode.meta.topic}</div>
            <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">topic filter</p>
            <Row k="Subscribers" v={`${subscribersFor(graph, selNode.id).length} client(s)`} />
            <TopicList topics={subscribersFor(graph, selNode.id)} />
          </Card>
        )}
      </div>
    </div>
  );
}

function subsFor(graph, clientId) {
  return graph.links.filter((l) => l.source === clientId).map((l) => graph.nodes.find((n) => n.id === l.target)?.meta?.topic).filter(Boolean);
}
function subscribersFor(graph, topicId) {
  return graph.links.filter((l) => l.target === topicId).map((l) => graph.nodes.find((n) => n.id === l.source)?.label).filter(Boolean);
}

function TopicList({ topics }) {
  if (!topics.length) return null;
  return (
    <div className="mt-2 max-h-40 space-y-0.5 overflow-y-auto rounded-lg bg-black/20 p-2 font-mono text-[11px] text-slate-300">
      {topics.map((t) => (
        <div key={t} className="truncate">
          {t}
        </div>
      ))}
    </div>
  );
}
function Stat({ label, value }) {
  return (
    <div className="rounded-lg bg-black/20 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-semibold text-slate-100">{value ?? '—'}</div>
    </div>
  );
}
function Row({ k, v }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-500">{k}</span>
      <span className="truncate text-slate-300">{v}</span>
    </div>
  );
}
