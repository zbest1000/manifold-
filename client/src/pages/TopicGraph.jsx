import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Share2, X, Gauge, Clock, Hash, Send } from 'lucide-react';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import ForceGraph from '@/graph/ForceGraph';
import { buildMqttGraph } from '@/graph/buildGraph';
import GraphToolbar from '@/components/GraphToolbar';
import JsonView from '@/components/JsonView';
import { Card, Button, Badge, EmptyState, Input } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import { formatDistanceToNow } from 'date-fns';

export default function TopicGraph() {
  const brokers = useStore((s) => s.brokers);
  const topics = useStore((s) => s.topics);
  const liveMessages = useStore((s) => s.liveMessages);
  const graphStyle = useStore((s) => s.graphStyle);
  const graphLayout = useStore((s) => s.graphLayout);
  const setTopics = useStore((s) => s.setTopics);

  const [brokerId, setBrokerId] = useState(null);
  const [selected, setSelected] = useState(null);

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

  const broker = brokers.find((b) => b.id === brokerId);
  const brokerTopics = topics[brokerId] || [];

  const graph = useMemo(() => {
    if (!broker) return { nodes: [], links: [] };
    return buildMqttGraph(broker, brokerTopics);
  }, [broker, brokerTopics]);

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
        title="Topic Graph"
        subtitle={broker ? `${graph.nodes.length} nodes · ${brokerTopics.length} topics` : 'Select a broker'}
        actions={
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
        }
      />

      <div className="relative flex flex-1 overflow-hidden">
        <div className="relative flex-1">
          <GraphToolbar />
          <ForceGraph
            data={graph}
            styleId={graphStyle}
            layoutId={graphLayout}
            selectedId={selected?.id || null}
            onSelect={setSelected}
          />
          <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-[11px] text-slate-500 backdrop-blur">
            Drag to move nodes · scroll to zoom · click a node for details
          </div>
        </div>

        {selected && (
          <TopicPanel
            node={selected}
            brokerId={brokerId}
            messages={liveMessages[brokerId] || []}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

function TopicPanel({ node, brokerId, messages, onClose }) {
  const meta = node.meta || {};
  const fullTopic = meta.fullTopic;
  const [history, setHistory] = useState([]);
  const [publishValue, setPublishValue] = useState('');

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
      await api.publish(brokerId, fullTopic, publishValue);
      toast.success('Published');
      setPublishValue('');
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-white/5 bg-surface-900/50">
      <div className="flex items-start justify-between gap-2 border-b border-white/5 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-slate-500">
            {meta.isLeaf ? 'Topic' : node.kind === 'broker' ? 'Broker' : 'Topic branch'}
          </p>
          <p className="mono mt-0.5 break-all text-sm font-medium text-slate-100">
            {fullTopic || node.label}
          </p>
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
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Latest payload</p>
            {latest.sparkplug ? (
              <JsonView data={latest.sparkplug} name="sparkplug" />
            ) : typeof latest.payload === 'object' ? (
              <JsonView data={latest.payload} />
            ) : (
              <pre className="mono max-h-56 overflow-auto whitespace-pre-wrap break-all text-xs text-emerald-300">
                {String(latest.payload)}
              </pre>
            )}
          </Card>
        )}

        {meta.isLeaf && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Publish</p>
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
          </div>
        )}

        {merged.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              History ({merged.length})
            </p>
            <div className="space-y-1">
              {merged.map((m) => (
                <div key={m.id} className="rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-slate-500">
                      {new Date(m.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="text-[11px] text-slate-600">QoS {m.qos}</span>
                  </div>
                  <p className="mono mt-0.5 truncate text-xs text-slate-300">
                    {typeof m.payload === 'object' ? JSON.stringify(m.payload) : String(m.payload)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
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
