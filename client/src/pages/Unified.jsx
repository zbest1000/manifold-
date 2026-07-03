import { useEffect, useMemo, useRef, useState } from 'react';
import { Network, Radio, Cpu, Boxes, Share2, Box } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import ForceGraph from '@/graph/ForceGraph';
import ForceGraph3D from '@/graph/ForceGraph3D';
import { buildMqttGraph, buildI3xGraph, mergeGraphs, PROTOCOL_COLORS } from '@/graph/buildGraph';
import GraphToolbar from '@/components/GraphToolbar';
import GraphSearch from '@/components/GraphSearch';
import { downloadDataUrl, downloadJson } from '@/lib/download';
import { EmptyState } from '@/components/ui';
import PageHeader from '@/components/PageHeader';

function ViewTab({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition',
        active ? 'bg-accent-500/20 text-accent-200' : 'bg-surface-950/60 text-slate-400 hover:text-slate-200'
      )}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

/**
 * One canvas that overlays every connected source — MQTT brokers, OPC UA
 * servers, and i3X objects — color-coded by protocol. The "single pane" view of
 * a mixed industrial network.
 */
export default function Unified() {
  const brokers = useStore((s) => s.brokers);
  const opcua = useStore((s) => s.opcua);
  const topicVersion = useStore((s) => s.topicVersion);
  const graphStyle = useStore((s) => s.graphStyle);
  const graphLayout = useStore((s) => s.graphLayout);
  const showMinimap = useStore((s) => s.showMinimap);
  const setTopics = useStore((s) => s.setTopics);

  const [i3xGraph, setI3xGraph] = useState(null);
  const [selected, setSelected] = useState(null);
  const [matchIds, setMatchIds] = useState(null);
  const [view, setView] = useState('graph');
  const graphRef = useRef(null);

  const connectedBrokers = brokers.filter((b) => b.status === 'connected');
  const connectedOpcua = opcua.filter((c) => c.status === 'connected');

  // Pull topic lists for all connected brokers
  useEffect(() => {
    connectedBrokers.forEach((b) => {
      api.brokerTopics(b.id).then((r) => setTopics(b.id, r.topics)).catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedBrokers.map((b) => b.id).join(',')]);

  // Pull the i3X object graph if a server is connected
  useEffect(() => {
    api
      .i3xStatus()
      .then((s) => {
        if (s.configured && s.info) return api.i3xObjects().then((r) => buildI3xGraph({ baseUrl: s.baseUrl, info: s.info }, r.objects));
        return null;
      })
      .then(setI3xGraph)
      .catch(() => setI3xGraph(null));
  }, []);

  const topicKey = connectedBrokers.map((b) => `${b.id}:${topicVersion[b.id] || 0}`).join(',');
  const graph = useMemo(() => {
    const state = useStore.getState();
    const parts = [];
    for (const b of connectedBrokers) parts.push({ protocol: 'mqtt', graph: buildMqttGraph(b, state.getTopics(b.id)) });
    for (const c of connectedOpcua) {
      // Show OPC UA servers as a single node each (address space is lazy-loaded on its own page)
      parts.push({
        protocol: 'opcua',
        graph: { nodes: [{ id: `opcua:${c.id}:root`, label: c.name, group: 'server', kind: 'opcua-server', degree: 0, meta: { connectionId: c.id } }], links: [] }
      });
    }
    if (i3xGraph) parts.push({ protocol: 'i3x', graph: i3xGraph });
    return mergeGraphs(parts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicKey, connectedOpcua.map((c) => c.id).join(','), i3xGraph]);

  const total = connectedBrokers.length + connectedOpcua.length + (i3xGraph ? 1 : 0);

  if (total === 0) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Unified Network" subtitle="Every connected source on one canvas" />
        <EmptyState
          icon={Network}
          title="Nothing connected yet"
          hint="Connect an MQTT broker, OPC UA server, or i3X endpoint to see them combined here."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Unified Network"
        subtitle={`${graph.nodes.length} nodes across ${total} source${total > 1 ? 's' : ''}`}
        actions={
          <div className="flex overflow-hidden rounded-xl border border-white/10">
            <ViewTab active={view === 'graph'} onClick={() => setView('graph')} icon={Share2} label="Graph" />
            <ViewTab active={view === '3d'} onClick={() => setView('3d')} icon={Box} label="3D" />
          </div>
        }
      />
      <div className="relative flex-1 overflow-hidden">
        {view === '3d' ? (
          <ForceGraph3D data={graph} styleId={graphStyle} selectedId={selected?.id || null} onSelect={setSelected} colorByProtocol />
        ) : (
          <>
            <GraphSearch nodes={graph.nodes} onMatches={setMatchIds} onFit={(ids) => graphRef.current?.fitTo(ids)} />
            <GraphToolbar
              onFit={() => graphRef.current?.fitTo()}
              onExportPng={() => downloadDataUrl(graphRef.current?.exportPng(), 'unified-network.png')}
              onExportJson={() => downloadJson(graphRef.current?.exportGraph(), 'unified-network.json')}
            />
            <ForceGraph
              ref={graphRef}
              data={graph}
              styleId={graphStyle}
              layoutId={graphLayout}
              selectedId={selected?.id || null}
              onSelect={setSelected}
              matchIds={matchIds}
              minimap={showMinimap}
              colorByProtocol
            />
          </>
        )}
        <div className="pointer-events-none absolute bottom-4 left-4 flex gap-3 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-[11px] backdrop-blur">
          <Legend icon={Radio} color={PROTOCOL_COLORS.mqtt} label="MQTT" />
          <Legend icon={Cpu} color={PROTOCOL_COLORS.opcua} label="OPC UA" />
          <Legend icon={Boxes} color={PROTOCOL_COLORS.i3x} label="i3X" />
        </div>
      </div>
    </div>
  );
}

function Legend({ icon: Icon, color, label }) {
  return (
    <span className="flex items-center gap-1.5 text-slate-300">
      <Icon size={12} style={{ color }} />
      {label}
    </span>
  );
}
