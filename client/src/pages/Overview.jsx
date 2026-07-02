import { Link } from 'react-router-dom';
import { Radio, Cpu, Share2, Radar, ArrowRight, MessageSquare } from 'lucide-react';
import { useStore } from '@/store/store';
import { Card, Badge, Button } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import { formatDistanceToNow } from 'date-fns';

export default function Overview() {
  const brokers = useStore((s) => s.brokers);
  const opcua = useStore((s) => s.opcua);
  const topics = useStore((s) => s.topics);
  const liveMessages = useStore((s) => s.liveMessages);

  const topicCount = Object.values(topics).reduce((acc, t) => acc + t.length, 0);
  const recent = Object.values(liveMessages)
    .flat()
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 12);

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
