import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, Users, Radio, RefreshCw, Trash2, ShieldCheck, AlertTriangle, MapPinned, MoonStar } from 'lucide-react';
import { api } from '@/lib/api';
import { useStore } from '@/store/store';
import { buildLineageGraph, coverageToMatchIds } from '@/graph/buildGraph';
import { topicMatches } from '@/lib/mqtt';
import ForceGraph from '@/graph/ForceGraph';
import { Card, Badge, Button, Input, Field, EmptyState } from '@/components/ui';

/**
 * Consumers: who RECEIVES what, with wildcards resolved.
 *
 * A subscription filter is a query, not a destination — `spBv1.0/#` from two
 * clients can cover entirely different concrete topics. This view fetches the
 * per-client subscriptions from the broker admin API, resolves every unique
 * filter against the actually-observed topic set (server trie: exact counts,
 * covering roots, topic samples), and renders the lineage
 * Broker → Client → Filter (n matches) → matched subtrees → (drill-down) leaves.
 * Dormant filters (matching nothing) are flagged — dead wiring is a finding.
 */
export default function ConsumerFlows({ broker }) {
  const graphStyle = useStore((s) => s.graphStyle);
  const setCoverage = useStore((s) => s.setCoverage);
  const [admin, setAdmin] = useState(null);
  const [form, setForm] = useState({ type: 'emqx', url: '', apiKey: '', apiSecret: '' });
  const [data, setData] = useState(null); // pubsub + resolution
  const [expanded, setExpanded] = useState(new Map()); // path -> children[]
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const graphRef = useRef(null);
  // Per-client traffic rates, derived by diffing the admin API's cumulative
  // counters between two refreshes (EMQX exposes them; HiveMQ doesn't).
  const countersRef = useRef(new Map()); // clientId -> { msgsIn, msgsOut, ts }
  const [clientRates, setClientRates] = useState(new Map());

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
    setExpanded(new Map());
    setError(null);
    setSelected(null);
    refreshConfig();
  }, [broker?.id, refreshConfig]);

  const load = useCallback(async () => {
    if (!broker?.id) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.brokerAdminPubSub(broker.id, { resolve: true, sampleLimit: 50 });
      setData(res);
      setExpanded(new Map());
      // Roll cumulative counters into per-client msg/s across refreshes.
      const now = Date.now();
      const rates = new Map();
      for (const c of res.clients || []) {
        const cur = c.counters;
        if (!cur || cur.msgsIn == null) continue;
        const prev = countersRef.current.get(c.id);
        if (prev && now > prev.ts) {
          const dt = (now - prev.ts) / 1000;
          rates.set(c.id, {
            inRate: Math.max(0, (cur.msgsIn - prev.msgsIn) / dt),
            outRate: Math.max(0, ((cur.msgsOut ?? 0) - (prev.msgsOut ?? 0)) / dt)
          });
        }
        countersRef.current.set(c.id, { msgsIn: cur.msgsIn, msgsOut: cur.msgsOut ?? 0, ts: now });
      }
      setClientRates(rates);
    } catch (e) {
      setError(e.message || 'Failed to reach broker admin API');
    } finally {
      setBusy(false);
    }
  }, [broker?.id]);

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
    () => (data && broker ? buildLineageGraph(broker, data, data.resolution || null, expanded) : { nodes: [], links: [] }),
    [data, broker, expanded]
  );
  const selNode = selected ? graph.nodes.find((n) => n.id === selected) : null;
  const uniqueFilters = useMemo(() => [...new Set((data?.subscriptions || []).map((s) => s.topic))], [data]);

  // Double-click an aggregate → fetch one level of the real topic tree.
  const expand = useCallback(
    async (node) => {
      if (node.kind !== 'topic-agg' || !node.meta?.path) return;
      const path = node.meta.path;
      if (expanded.has(path)) {
        // collapse: drop this path and any expanded descendants
        const next = new Map([...expanded].filter(([p]) => p !== path && !p.startsWith(`${path}/`)));
        setExpanded(next);
        return;
      }
      try {
        const res = await api.topicTree(broker.id, path, 300);
        setExpanded((prev) => new Map(prev).set(path, res.children || []));
      } catch {
        /* transient */
      }
    },
    [broker?.id, expanded]
  );

  // Clients receiving a concrete topic = filters that match it, reverse-mapped.
  const subscribersOfTopic = useCallback(
    (topicPath) => {
      const matching = uniqueFilters.filter((f) => topicMatches(f, topicPath));
      const clients = new Set();
      for (const s of data?.subscriptions || []) {
        if (matching.includes(s.topic)) clients.add(s.clientId);
      }
      return { filters: matching, clients: [...clients] };
    },
    [uniqueFilters, data]
  );

  const paintCoverage = useCallback(
    (clientId) => {
      const filters = (data?.subscriptions || []).filter((s) => s.clientId === clientId).map((s) => s.topic);
      const results = filters.map((f) => data?.resolution?.byFilter?.[f]).filter(Boolean);
      const matchIds = coverageToMatchIds(broker.id, results);
      setCoverage({ brokerId: broker.id, matchIds, label: `Coverage: ${clientId}` });
    },
    [data, broker?.id, setCoverage]
  );

  if (!admin?.configured) {
    return (
      <div className="grid h-full place-items-center overflow-y-auto p-8">
        <Card className="w-full max-w-md p-5">
          <div className="mb-1 flex items-center gap-2 text-base font-semibold text-slate-100">
            <ShieldCheck size={18} className="text-accent-400" /> Connect a broker admin API
          </div>
          <p className="mb-4 text-xs leading-relaxed text-slate-400">
            Per-client subscriptions aren&apos;t exposed by MQTT or <code>$SYS</code> — only a broker admin API can reveal them. Point this at an <strong>EMQX v5</strong> REST endpoint, and every subscription filter will also be <strong>resolved against the topics actually observed</strong> on this broker — down to the concrete leaves each client receives.
          </p>
          <form onSubmit={save} className="space-y-3">
            <Field label="Admin type">
              <select
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200"
              >
                <option value="emqx">EMQX v5 (REST)</option>
                <option value="hivemq">HiveMQ Enterprise (REST)</option>
              </select>
              {form.type === 'hivemq' && (
                <p className="mt-1 text-[10px] leading-snug text-slate-500">
                  Base URL of the HiveMQ REST API (e.g. http://broker-host:8888). Leave key empty; put a bearer token in
                  the secret field if the API requires one.
                </p>
              )}
            </Field>
            <Field label="API base URL">
              <Input placeholder="http://broker-host:18083/api/v5" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} required />
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
              {busy ? 'Connecting…' : 'Connect & resolve subscriptions'}
            </Button>
          </form>
          <p className="mt-3 text-[11px] text-slate-500">The API secret is stored server-side only and never sent back to the browser.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full">
      <div className="relative flex-1">
        {graph.nodes.length > 1 ? (
          <ForceGraph
            ref={graphRef}
            data={graph}
            styleId={graphStyle}
            layoutId="organic"
            selectedId={selected}
            onSelect={(n) => setSelected(n.id)}
            onExpand={expand}
          />
        ) : (
          <div className="grid h-full place-items-center p-8">
            <EmptyState
              icon={Users}
              title={error ? 'Admin API error' : busy ? 'Resolving subscriptions…' : 'No subscriptions reported'}
              hint={error || 'The broker admin API returned no clients/subscriptions yet.'}
            />
          </div>
        )}
        {graph.nodes.length > 1 && (
          <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-[11px] text-slate-400 backdrop-blur">
            filters show exact match counts · double-click an aggregate to drill into real topics · red = dormant filter
          </div>
        )}
        {data?.resolution && (
          <div className="pointer-events-none absolute right-4 top-4 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-[11px] text-slate-500 backdrop-blur">
            resolved against {data.resolution.topicTotal.toLocaleString()} observed topics
            {data.resolution.dropped > 0 && ` · ${data.resolution.dropped.toLocaleString()} dropped at cap`}
          </div>
        )}
      </div>

      <div className="w-80 shrink-0 space-y-3 overflow-y-auto border-l border-white/5 bg-surface-900/30 p-3">
        <Card className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Radio size={15} className="text-accent-400" /> Consumption map
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
            <div className="grid grid-cols-3 gap-2 text-xs">
              <Stat label="Clients" value={data.clients?.length} />
              <Stat label="Filters" value={uniqueFilters.length} />
              <Stat
                label="Dormant"
                value={uniqueFilters.filter((f) => data.resolution?.byFilter?.[f]?.matchCount === 0).length}
                tone="rose"
              />
            </div>
          )}
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
              <ClientTraffic
                client={(data?.clients || []).find((c) => `ps:${broker.id}:c:${c.id}` === selNode.id)}
                rate={clientRates.get(selNode.label)}
              />
            </div>
            <div className="mt-2 space-y-1">
              {(data?.subscriptions || [])
                .filter((s) => `ps:${broker.id}:c:${s.clientId}` === selNode.id)
                .map((s) => {
                  const r = data?.resolution?.byFilter?.[s.topic];
                  return (
                    <div key={s.topic} className="flex items-center justify-between gap-2 rounded-lg bg-black/20 px-2 py-1 font-mono text-[11px]">
                      <span className="truncate text-slate-300">{s.topic}</span>
                      {r &&
                        (r.matchCount === 0 ? (
                          <span className="flex shrink-0 items-center gap-1 text-rose-300">
                            <MoonStar size={10} /> dormant
                          </span>
                        ) : (
                          <span className="shrink-0 text-slate-500">{r.matchCount.toLocaleString()}</span>
                        ))}
                    </div>
                  );
                })}
            </div>
            <Button size="sm" variant="outline" className="mt-2 w-full" onClick={() => paintCoverage(selNode.label)}>
              <MapPinned size={13} className="mr-1.5" /> Show coverage on topic map
            </Button>
          </Card>
        )}

        {selNode?.meta?.kind === 'filter' && (
          <Card className="p-3">
            <div className="mb-1 truncate font-mono text-sm font-semibold text-slate-100">{selNode.meta.topic}</div>
            <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">
              subscription filter{selNode.meta.share ? ` · $share group "${selNode.meta.share}"` : ''}
            </p>
            {selNode.meta.dormant ? (
              <p className="flex items-center gap-1.5 rounded-lg bg-rose-500/10 px-2 py-1.5 text-xs text-rose-300">
                <MoonStar size={13} /> Matches nothing observed — dormant subscription
              </p>
            ) : (
              <div className="space-y-1 text-xs text-slate-400">
                <Row k="Matches" v={`${selNode.meta.matchCount?.toLocaleString()} topics`} />
                <Row k="Subscribers" v={`${graph.links.filter((l) => l.target === selNode.id && l.kind === 'subscribe').length} client(s)`} />
              </div>
            )}
            {selNode.meta.sample?.length > 0 && (
              <div className="mt-2">
                <p className="mb-1 text-[11px] font-medium text-slate-400">
                  Concrete topics{selNode.meta.sampleTruncated && ` (${selNode.meta.sample.length} of ${selNode.meta.matchCount?.toLocaleString()})`}
                </p>
                <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-lg bg-black/20 p-2 font-mono text-[11px] text-slate-300">
                  {selNode.meta.sample.map((s) => (
                    <div key={s.topic} className="truncate">
                      {s.topic}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        )}

        {(selNode?.meta?.kind === 'topic' || selNode?.meta?.kind === 'aggregate') && (
          <TopicCard node={selNode} subscribersOfTopic={subscribersOfTopic} />
        )}
      </div>
    </div>
  );
}

// Cumulative counters always; live msg/s appears from the second refresh on
// (rates are the delta between two admin snapshots).
function ClientTraffic({ client, rate }) {
  const c = client?.counters;
  if (!c || c.msgsIn == null) return null;
  return (
    <>
      <Row k="Msgs in / out" v={`${c.msgsIn.toLocaleString()} / ${(c.msgsOut ?? 0).toLocaleString()}`} />
      {rate ? (
        <Row k="Rate in / out" v={`${rate.inRate.toFixed(1)} / ${rate.outRate.toFixed(1)} msg/s`} />
      ) : (
        <p className="text-[10px] text-slate-500">refresh again for live rates</p>
      )}
    </>
  );
}

function TopicCard({ node, subscribersOfTopic }) {
  const path = node.meta.path;
  const isAgg = node.meta.kind === 'aggregate';
  const { filters, clients } = subscribersOfTopic(path);
  const sp = path.startsWith('spBv1.0/') ? path.split('/') : null;
  return (
    <Card className="p-3">
      <div className="mb-1 truncate font-mono text-sm font-semibold text-slate-100">{path}</div>
      <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">{isAgg ? `namespace · ${node.meta.subtreeCount?.toLocaleString()} topics` : 'concrete topic'}</p>
      {!isAgg && (
        <>
          <p className="mb-1 text-[11px] font-medium text-slate-400">Received by {clients.length} client(s)</p>
          <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-lg bg-black/20 p-2 font-mono text-[11px] text-slate-300">
            {clients.length ? clients.map((c) => <div key={c}>{c}</div>) : <span className="text-slate-500">no matching subscriptions</span>}
          </div>
          {filters.length > 0 && <p className="mt-1 text-[10px] text-slate-500">via {filters.join(' · ')}</p>}
          {sp ? (
            <p className="mt-2 text-[11px] text-slate-400">
              Publisher: Sparkplug <span className="font-mono text-slate-300">{sp[3]}{sp[4] ? ` / ${sp.slice(4).join('/')}` : ''}</span> (group {sp[1]}) — see Producers tab
            </p>
          ) : (
            <p className="mt-2 text-[10px] leading-snug text-slate-500">MQTT does not identify publishers for non-Sparkplug topics.</p>
          )}
        </>
      )}
      {isAgg && <p className="text-[11px] text-slate-500">Double-click the node to drill into this namespace.</p>}
    </Card>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className="rounded-lg bg-black/20 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-sm font-semibold ${tone === 'rose' && value > 0 ? 'text-rose-300' : 'text-slate-100'}`}>{value ?? '—'}</div>
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
