import { Palette, Terminal, Info, Check } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '@/store/store';
import { STYLE_LIST, LAYOUT_LIST } from '@/graph/graphStyles';
import { Card, Badge } from '@/components/ui';
import PageHeader from '@/components/PageHeader';

const MCP_SNIPPET = `{
  "mcpServers": {
    "topic-canvas": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/index.js"],
      "env": { "TOPIC_CANVAS_API_URL": "http://localhost:5000" }
    }
  }
}`;

export default function Settings() {
  const { graphStyle, graphLayout, setGraphStyle, setGraphLayout, connected } = useStore();

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings" subtitle="Graph appearance and integrations" />

      <div className="flex-1 space-y-6 overflow-y-auto p-6">
        <Card className="p-5">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Palette size={16} className="text-accent-400" /> Default graph style
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {STYLE_LIST.map((s) => (
              <button
                key={s.id}
                onClick={() => setGraphStyle(s.id)}
                className={clsx(
                  'group overflow-hidden rounded-xl border text-left transition',
                  s.id === graphStyle ? 'border-accent-500/70 ring-1 ring-accent-500/40' : 'border-white/10 hover:border-white/25'
                )}
              >
                <div className="h-16" style={{ background: s.background }}>
                  <svg viewBox="0 0 120 64" className="h-full w-full">
                    <line x1="30" y1="40" x2="60" y2="22" stroke={s.link.color} />
                    <line x1="60" y1="22" x2="90" y2="40" stroke={s.link.color} />
                    <line x1="60" y1="22" x2="60" y2="50" stroke={s.link.color} />
                    <circle cx="30" cy="40" r="5" fill={s.palette[0]} stroke={s.node.stroke} strokeWidth={s.node.strokeWidth || 0} />
                    <circle cx="60" cy="22" r="8" fill={s.palette[1] || s.palette[0]} stroke={s.node.stroke} strokeWidth={s.node.strokeWidth || 0} />
                    <circle cx="90" cy="40" r="5" fill={s.palette[2] || s.palette[0]} stroke={s.node.stroke} strokeWidth={s.node.strokeWidth || 0} />
                    <circle cx="60" cy="50" r="4" fill={s.palette[3] || s.palette[0]} stroke={s.node.stroke} strokeWidth={s.node.strokeWidth || 0} />
                  </svg>
                </div>
                <div className="flex items-center justify-between px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-200">{s.name}</p>
                    <p className="text-[11px] text-slate-500">{s.description}</p>
                  </div>
                  {s.id === graphStyle && <Check size={15} className="shrink-0 text-accent-400" />}
                </div>
              </button>
            ))}
          </div>

          <h3 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-slate-400">Layout</h3>
          <div className="flex flex-wrap gap-2">
            {LAYOUT_LIST.map((l) => (
              <button
                key={l.id}
                onClick={() => setGraphLayout(l.id)}
                className={clsx(
                  'rounded-lg border px-3 py-1.5 text-sm font-medium transition',
                  l.id === graphLayout ? 'border-accent-500/70 bg-accent-500/10 text-accent-300' : 'border-white/10 text-slate-300 hover:border-white/25'
                )}
              >
                {l.name}
              </button>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Terminal size={16} className="text-accent-400" /> MCP integration
          </h2>
          <p className="mb-3 text-sm text-slate-400">
            Topic Canvas ships an MCP server so AI assistants and agents can discover brokers, browse topics,
            read payloads, and walk OPC UA address spaces through the same backend. Add this to your MCP client
            config:
          </p>
          <pre className="mono overflow-x-auto rounded-xl border border-white/10 bg-surface-950/70 p-4 text-xs leading-relaxed text-slate-300">
            {MCP_SNIPPET}
          </pre>
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Info size={16} className="text-accent-400" /> System
          </h2>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Realtime link</span>
              <Badge status={connected ? 'connected' : 'disconnected'}>{connected ? 'connected' : 'offline'}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Client</span>
              <span className="mono text-slate-300">Topic Canvas 2.0</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
