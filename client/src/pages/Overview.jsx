import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Radio, Cpu, Share2, Radar, ArrowRight, MessageSquare, Workflow, Database, Tag, BellRing } from 'lucide-react';
import { useStore } from '@/store/store';
import { socket } from '@/lib/socket';
import { api } from '@/lib/api';
import { Card, Badge, Button } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import { formatDistanceToNow } from 'date-fns';

const sum = (obj, field) => Object.values(obj || {}).reduce((acc, v) => acc + (Number(v?.[field]) || 0), 0);

export default function Overview() {
  const brokers = useStore((s) => s.brokers);
  const opcua = useStore((s) => s.opcua);
  const dataTick = useStore((s) => s.dataTick);
  const topicVersion = useStore((s) => s.topicVersion);
  const [engine, setEngine] = useState(null); // pushed every 2s while anything is connected
  const [alerts, setAlerts] = useState(null); // { rules, recent } — config, polled slowly

  useEffect(() => {
    socket.on('engine-metrics', setEngine);
    return () => socket.off('engine-metrics', setEngine);
  }, []);

  useEffect(() => {
    let stop = false;
    const load = () =>
      Promise.all([api.listAlertRules(), api.alertEvents(50)])
        .then(([r, e]) => !stop && setAlerts({ rules: r.rules.length, recent: e.events.length, latest: e.events[0] || null }))
        .catch(() => {});
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  // Read high-frequency data from the non-reactive store snapshot; refreshes at
  // the throttled tick / structure change rather than on every message.
  const { topicCount, recent } = useMemo(() => {
    const state = useStore.getState();
    let count = 0;
    let all = [];
    for (const b of brokers) {
      count += state.getTopics(b.id).length;
      all = all.concat(state.getLiveMessages(b.id));
    }
    all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return { topicCount: count, recent: all.slice(0, 12) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokers, dataTick, topicVersion]);

  const stats = [
    { label: 'MQTT Brokers', value: brokers.length, icon: Radio, to: '/brokers', accent: 'from-sky-400 to-sky-600' },
    { label: 'OPC UA Servers', value: opcua.length, icon: Cpu, to: '/opcua', accent: 'from-violet-400 to-violet-600' },
    { label: 'Topics Tracked', value: topicCount, icon: Share2, to: '/topics', accent: 'from-emerald-400 to-emerald-600' }
  ];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Overview"
        subtitle="Live snapshot of your MQTT and OPC UA connections"
        actions={
          <Link to="/discovery">
            <Button variant="outline">
              <Radar size={15} /> Discover network
            </Button>
          </Link>
        }
      />

      <div className="flex-1 space-y-6 overflow-y-auto p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {stats.map((s) => (
            <Link key={s.label} to={s.to}>
              <Card className="group p-5 transition hover:border-white/10 hover:bg-surface-900/80">
                <div className="flex items-center justify-between">
                  <div className={`grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br ${s.accent} shadow-lg`}>
                    <s.icon size={20} className="text-white" />
                  </div>
                  <ArrowRight size={16} className="text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-slate-400" />
                </div>
                <p className="mt-4 text-3xl font-semibold tracking-tight">{s.value}</p>
                <p className="text-sm text-slate-500">{s.label}</p>
              </Card>
            </Link>
          ))}
        </div>

        {(engine || alerts) && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <HealthCard
              to="/pipelines"
              icon={Workflow}
              label="Pipelines"
              value={Object.keys(engine?.pipelines || {}).length}
              unit="active routes"
              lines={[
                `${sum(engine?.pipelines, 'published').toLocaleString()} delivered`,
                sum(engine?.pipelines, 'errors') + sum(engine?.pipelines, 'loopBlocked') > 0 &&
                  `${sum(engine?.pipelines, 'errors')} errors · ${sum(engine?.pipelines, 'loopBlocked')} loop-blocked`
              ]}
              warn={sum(engine?.pipelines, 'errors') > 0}
            />
            <HealthCard
              to="/pipelines"
              icon={Database}
              label="Historians"
              value={sum(engine?.outbox, 'written').toLocaleString()}
              unit="points written"
              lines={[
                `${sum(engine?.outbox, 'queued')} queued`,
                sum(engine?.outbox, 'spillBytes') > 0 && `${(sum(engine?.outbox, 'spillBytes') / 1024).toFixed(1)} KB spilled to disk`,
                sum(engine?.outbox, 'dropped') > 0 && `${sum(engine?.outbox, 'dropped')} dropped`
              ]}
              warn={sum(engine?.outbox, 'spillBytes') > 0 || sum(engine?.outbox, 'dropped') > 0}
            />
            <HealthCard
              to="/tags"
              icon={Tag}
              label="Tag bindings"
              value={sum(engine?.bindings, 'published').toLocaleString()}
              unit="values published"
              lines={[
                `${sum(engine?.bindings, 'suppressed').toLocaleString()} deadband-suppressed`,
                sum(engine?.bindings, 'errors') > 0 && `${sum(engine?.bindings, 'errors')} errors`
              ]}
              warn={sum(engine?.bindings, 'errors') > 0}
            />
            <HealthCard
              to="/settings"
              icon={BellRing}
              label="Alerts"
              value={alerts?.recent ?? 0}
              unit={`recent events · ${alerts?.rules ?? 0} rules`}
              lines={[alerts?.latest && `latest: ${alerts.latest.detail || alerts.latest.ruleName || ''}`]}
              warn={(alerts?.recent ?? 0) > 0}
            />
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-200">Connections</h2>
            {brokers.length === 0 && opcua.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">
                No active connections. Add a broker or run discovery to get started.
              </p>
            ) : (
              <div className="space-y-2">
                {brokers.map((b) => (
                  <Row key={b.id} icon={Radio} name={b.name} sub={`${b.host}:${b.port}`} status={b.status} />
                ))}
                {opcua.map((c) => (
                  <Row key={c.id} icon={Cpu} name={c.name} sub={c.endpointUrl} status={c.status} />
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
              <MessageSquare size={15} className="text-accent-400" /> Recent messages
            </h2>
            {recent.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">Live messages will appear here.</p>
            ) : (
              <div className="space-y-1.5">
                {recent.map((m) => (
                  <div key={m.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5">
                    <span className="mono flex-1 truncate text-xs text-slate-300">{m.topic}</span>
                    <Badge className="shrink-0">{m.type}</Badge>
                    <span className="shrink-0 text-[11px] text-slate-600">
                      {formatDistanceToNow(new Date(m.timestamp), { addSuffix: true })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function HealthCard({ to, icon: Icon, label, value, unit, lines = [], warn = false }) {
  return (
    <Link to={to}>
      <Card className="group h-full p-4 transition hover:border-white/10 hover:bg-surface-900/80">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-slate-300">
            <Icon size={15} className={warn ? 'text-amber-400' : 'text-slate-400'} />
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</span>
          </div>
          <ArrowRight size={14} className="text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-slate-400" />
        </div>
        <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
        <p className="text-xs text-slate-500">{unit}</p>
        <div className="mt-1.5 space-y-0.5">
          {lines.filter(Boolean).map((l) => (
            <p key={l} className="truncate text-[11px] text-slate-500">
              {l}
            </p>
          ))}
        </div>
      </Card>
    </Link>
  );
}

function Row({ icon: Icon, name, sub, status }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
      <div className="grid h-9 w-9 place-items-center rounded-lg bg-white/5 text-slate-300">
        <Icon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-200">{name}</p>
        <p className="mono truncate text-xs text-slate-500">{sub}</p>
      </div>
      <Badge status={status} />
    </div>
  );
}
