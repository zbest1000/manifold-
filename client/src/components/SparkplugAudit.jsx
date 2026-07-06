import { useEffect, useMemo, useRef, useState } from 'react';
import { Cpu, Radio, Activity, Users, Info, CircleDot, CircleOff } from 'lucide-react';
import { api } from '@/lib/api';
import { useStore } from '@/store/store';
import { buildSparkplugGraph } from '@/graph/buildGraph';
import ForceGraph from '@/graph/ForceGraph';
import { Card, Badge, EmptyState } from '@/components/ui';
import { formatDistanceToNow } from 'date-fns';

/**
 * Audit view: who is actually publishing on this broker, and broker health.
 *
 * - Sparkplug B device topology (Group → Edge Node → Device) built from observed
 *   BIRTH/DEATH certificates — REAL publishing endpoints with live online state
 *   and each endpoint's metric set.
 * - Broker `$SYS` health / throughput / client + subscription counts.
 * - An honest note about what MQTT can and cannot reveal about subscribers.
 */
export default function SparkplugAudit({ broker }) {
  const graphStyle = useStore((s) => s.graphStyle);
  const [topology, setTopology] = useState(null);
  const [sys, setSys] = useState(null);
  const [selected, setSelected] = useState(null);
  const graphRef = useRef(null);

  useEffect(() => {
    if (!broker?.id) return undefined;
    let alive = true;
    const poll = async () => {
      try {
        const [sp, sy] = await Promise.all([api.brokerSparkplug(broker.id), api.brokerSys(broker.id)]);
        if (!alive) return;
        setTopology(sp);
        setSys(sy);
      } catch {
        /* broker may have gone away; keep last snapshot */
      }
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [broker?.id]);

  const graph = useMemo(
    () => (topology && broker ? buildSparkplugGraph(broker, topology) : { nodes: [], links: [] }),
    [topology, broker]
  );
  const selectedNode = selected ? graph.nodes.find((n) => n.id === selected) : null;
  const hasSparkplug = topology && topology.summary?.edgeNodes > 0;

  return (
    <div className="flex h-full w-full">
      <div className="relative flex-1">
        {hasSparkplug ? (
          <ForceGraph
            ref={graphRef}
            data={graph}
            styleId={graphStyle}
            layoutId="radial"
            selectedId={selected}
            onSelect={setSelected}
          />
        ) : (
          <div className="grid h-full place-items-center p-8">
            <EmptyState
              icon={Cpu}
              title="No Sparkplug devices seen yet"
              hint="This view maps real publishing endpoints from Sparkplug B BIRTH/DEATH certificates (spBv1.0/…). Connect to a broker carrying Sparkplug traffic and devices will appear here as they announce themselves."
            />
          </div>
        )}
        {hasSparkplug && (
          <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-[11px] text-slate-400 backdrop-blur">
            <span className="inline-flex items-center gap-1.5">
              <CircleDot size={12} className="text-emerald-400" /> online
            </span>
            <span className="ml-3 inline-flex items-center gap-1.5">
              <CircleOff size={12} className="text-rose-400" /> offline (DEATH)
            </span>
            <span className="ml-3">click a device for its metrics</span>
          </div>
        )}
      </div>

      <div className="w-80 shrink-0 space-y-3 overflow-y-auto border-l border-white/5 bg-surface-900/30 p-3">
        {/* Sparkplug topology summary */}
        <Card className="p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Radio size={15} className="text-accent-400" /> Sparkplug devices
          </div>
          {topology?.summary ? (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Stat label="Groups" value={topology.summary.groups} />
              <Stat label="Edge nodes" value={topology.summary.edgeNodes} />
              <Stat label="Devices" value={topology.summary.devices} />
              <Stat label="Online" value={topology.summary.online} tone="emerald" />
            </div>
          ) : (
            <p className="text-xs text-slate-500">Waiting for Sparkplug traffic…</p>
          )}
        </Card>

        {/* Selected endpoint detail */}
        {selectedNode && selectedNode.meta?.kind && (
          <Card className="p-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="truncate text-sm font-semibold text-slate-100">{selectedNode.label}</span>
              {'online' in selectedNode.meta && (
                <Badge status={selectedNode.meta.online ? 'connected' : 'error'}>
                  {selectedNode.meta.online ? 'online' : 'offline'}
                </Badge>
              )}
            </div>
            <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">{selectedNode.meta.kind}</p>
            <div className="space-y-1 text-xs text-slate-400">
              {selectedNode.meta.msgCount != null && <Row k="Messages" v={selectedNode.meta.msgCount.toLocaleString()} />}
              {selectedNode.meta.lastSeen && <Row k="Last seen" v={ago(selectedNode.meta.lastSeen)} />}
              {selectedNode.meta.lastBirth && <Row k="Birth" v={ago(selectedNode.meta.lastBirth)} />}
              {selectedNode.meta.lastDeath && <Row k="Death" v={ago(selectedNode.meta.lastDeath)} />}
            </div>
            {selectedNode.meta.metrics?.length > 0 && (
              <div className="mt-2">
                <p className="mb-1 text-[11px] font-medium text-slate-400">
                  Publishes {selectedNode.meta.metrics.length} metric{selectedNode.meta.metrics.length === 1 ? '' : 's'}
                </p>
                <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg bg-black/20 p-2 font-mono text-[11px] text-slate-300">
                  {selectedNode.meta.metrics.map((m) => (
                    <div key={m} className="truncate">
                      {m}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        )}

        {/* Broker $SYS health */}
        <Card className="p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Activity size={15} className="text-accent-400" /> Broker health ($SYS)
          </div>
          {sys?.available ? (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Stat label="Clients" value={fmt(sys.summary.clientsConnected)} icon={Users} />
              <Stat label="Subscriptions" value={fmt(sys.summary.subscriptionsCount)} />
              <Stat label="Msgs recv" value={fmt(sys.summary.messagesReceived)} />
              <Stat label="Msgs sent" value={fmt(sys.summary.messagesSent)} />
              <Stat label="Retained" value={fmt(sys.summary.retainedMessages)} />
              <Stat label="Uptime" value={sys.summary.uptimeSeconds != null ? uptime(sys.summary.uptimeSeconds) : '—'} />
              {sys.summary.version && <Stat label="Version" value={sys.summary.version} wide />}
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              This broker isn&apos;t publishing a <code className="text-slate-400">$SYS</code> tree (or hasn&apos;t yet). Broker health stats appear here when it does (Mosquitto, EMQX, …).
            </p>
          )}
        </Card>

        {/* Honest subscriber-visibility note */}
        <Card className="border-amber-500/20 bg-amber-500/[0.04] p-3">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-amber-200">
            <Info size={15} /> Who subscribes to what?
          </div>
          <p className="text-[11px] leading-relaxed text-slate-400">
            MQTT decouples publishers and subscribers — the protocol (and <code>$SYS</code>) expose only <strong>aggregate</strong> client and subscription <em>counts</em>, not a per-client subscription map. This tab shows <strong>who publishes what</strong> (the Sparkplug device tree + every published topic). For <strong>who subscribes to what</strong>, open the <strong>Subscribers</strong> tab and connect a broker admin API (EMQX / HiveMQ REST, or <code>mosquitto_ctrl</code>) — the only source that can reveal per-client subscriptions.
          </p>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, tone, icon: Icon, wide }) {
  return (
    <div className={`rounded-lg bg-black/20 px-2 py-1.5 ${wide ? 'col-span-2' : ''}`}>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-500">
        {Icon && <Icon size={10} />} {label}
      </div>
      <div className={`truncate text-sm font-semibold ${tone === 'emerald' ? 'text-emerald-300' : 'text-slate-100'}`}>{value ?? '—'}</div>
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

function fmt(v) {
  return v == null ? '—' : Number(v).toLocaleString();
}

function ago(ts) {
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return '—';
  }
}

function uptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
