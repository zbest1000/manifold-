import { useEffect, useState } from 'react';
import { Palette, Terminal, Info, Check, BellRing, Trash2, Plus, FileDown, FileUp, ScrollText } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import { STYLE_LIST, LAYOUT_LIST } from '@/graph/graphStyles';
import { Card, Badge, Button, Input, Field } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import { formatDistanceToNow } from 'date-fns';

const MCP_SNIPPET = `{
  "mcpServers": {
    "manifold": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/index.js"],
      "env": { "MANIFOLD_API_URL": "http://localhost:5000" }
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

        <AlertRulesCard />

        <ConfigCard />

        <AuditCard />

        <Card className="p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Terminal size={16} className="text-accent-400" /> MCP integration
          </h2>
          <p className="mb-3 text-sm text-slate-400">
            Manifold ships an MCP server so AI assistants and agents can discover brokers, browse topics,
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
              <span className="mono text-slate-300">Manifold 2.0</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

// Config as code: the whole DataOps configuration (routes, models, historians,
// recordings, contracts, bindings, mounts, alert rules) as one reviewable JSON
// file. Secrets are stripped on export and preserved server-side on re-import.
function ConfigCard() {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);

  const doExport = async () => {
    try {
      const cfg = await api.exportConfig();
      const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'manifold-config.json';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      // pushLog captured it
    }
  };

  const doImport = async (file) => {
    setImporting(true);
    setResult(null);
    try {
      const cfg = JSON.parse(await file.text());
      const res = await api.importConfig(cfg);
      setResult(res.imported);
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setImporting(false);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
        <FileDown size={16} className="text-accent-400" /> Configuration as code
      </h2>
      <p className="mb-3 text-sm text-slate-400">
        Export pipelines, models, historians, recordings, contracts, tag bindings, mounts, and alert rules as one JSON
        file — reviewable in git, promotable between environments. Credentials are never exported; stored secrets
        survive a re-import.
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={doExport}>
          <FileDown size={14} className="mr-1" /> Export config
        </Button>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 px-3.5 py-2 text-sm text-slate-200 hover:bg-white/5">
          <FileUp size={14} /> {importing ? 'Importing…' : 'Import config'}
          <input type="file" accept=".json" className="hidden" onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} />
        </label>
      </div>
      {result && (
        <p className={clsx('mt-2 text-xs', result.error ? 'text-rose-300' : 'text-emerald-300')}>
          {result.error || `Imported: ${Object.entries(result).map(([k, v]) => `${k} ${v}`).join(', ')}`}
        </p>
      )}
    </Card>
  );
}

// Audit trail: every mutating action against the control plane, newest first.
function AuditCard() {
  const [events, setEvents] = useState([]);
  useEffect(() => {
    const load = () => api.auditRecent(50).then((r) => setEvents(r.events)).catch(() => {});
    load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 10_000);
    return () => clearInterval(t);
  }, []);
  return (
    <Card className="p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
        <ScrollText size={16} className="text-accent-400" /> Audit trail
      </h2>
      <p className="mb-3 text-sm text-slate-400">
        Who changed what: every mutating API call and control socket event, with role and outcome. Persisted to
        <span className="mono"> data/audit.jsonl</span>; secrets are redacted before logging.
      </p>
      {events.length === 0 && <p className="text-xs text-slate-500">No mutating actions recorded yet.</p>}
      <div className="max-h-56 space-y-0.5 overflow-y-auto font-mono text-[11px]">
        {events.map((e, i) => (
          <div key={i} className="flex items-baseline gap-2 rounded bg-black/20 px-2 py-1">
            <span className="shrink-0 text-slate-500">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className={clsx('shrink-0', e.status >= 400 ? 'text-rose-300' : 'text-emerald-300')}>{e.status || e.method}</span>
            <span className="shrink-0 text-sky-300">{e.role}</span>
            <span className="min-w-0 truncate text-slate-300">
              {e.method} {e.path}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

const RULE_LABEL = {
  'branch-silent': 'Branch silent',
  'topic-silent': 'Topic silent',
  'new-topic': 'New topic appears'
};

// Alert rules: watch the namespace actively — a branch going quiet, a specific
// topic dying, or unexpected topics appearing. Rules are evaluated server-side
// every 15s; firings hit the socket, the events feed here, and (optionally) a
// webhook.
function AlertRulesCard() {
  const brokers = useStore((s) => s.brokers);
  const [rules, setRules] = useState([]);
  const [events, setEvents] = useState([]);
  const [form, setForm] = useState({ type: 'branch-silent', brokerId: '', path: '', topic: '', prefix: '', thresholdSec: 60, webhookUrl: '', name: '' });
  const [busy, setBusy] = useState(false);
  const connected = brokers.filter((b) => b.status === 'connected');

  const load = () => {
    api.listAlertRules().then((r) => setRules(r.rules)).catch(() => {});
    api.alertEvents(50).then((r) => setEvents(r.events)).catch(() => {});
  };
  useEffect(() => {
    load();
    const t = setInterval(() => api.alertEvents(50).then((r) => setEvents(r.events)).catch(() => {}), 10_000);
    return () => clearInterval(t);
  }, []);

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.saveAlertRule({
        name: form.name || null,
        type: form.type,
        brokerId: form.brokerId || connected[0]?.id,
        path: form.path,
        topic: form.topic || null,
        prefix: form.prefix,
        thresholdMs: Number(form.thresholdSec) * 1000,
        webhookUrl: form.webhookUrl || null
      });
      setForm((f) => ({ ...f, path: '', topic: '', prefix: '', name: '' }));
      load();
    } catch {
      // pushLog captured it
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    try {
      await api.deleteAlertRule(id);
      load();
    } catch {
      // pushLog captured it
    }
  };

  const brokerName = (id) => brokers.find((b) => b.id === id)?.name || id?.slice(0, 8) || '—';

  return (
    <Card className="p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
        <BellRing size={16} className="text-accent-400" /> Alert rules
      </h2>
      <p className="mb-3 text-sm text-slate-400">
        Watch the namespace actively: get notified when a branch goes silent, a topic stops publishing, or new topics
        appear where they shouldn&apos;t. Evaluated server-side; optional webhook per rule.
      </p>

      {rules.length > 0 && (
        <div className="mb-4 space-y-1.5">
          {rules.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg bg-black/20 px-3 py-2 text-xs">
              <span className="min-w-0">
                <span className="font-medium text-slate-200">{r.name || RULE_LABEL[r.type]}</span>
                <span className="ml-2 text-slate-500">
                  {RULE_LABEL[r.type]} · {brokerName(r.brokerId)}
                  {r.type === 'branch-silent' && ` · ${r.path || '(whole namespace)'} > ${Math.round(r.thresholdMs / 1000)}s`}
                  {r.type === 'topic-silent' && ` · ${r.topic} > ${Math.round(r.thresholdMs / 1000)}s`}
                  {r.type === 'new-topic' && (r.prefix ? ` · under ${r.prefix}` : ' · anywhere')}
                  {r.webhookUrl && ' · webhook'}
                </span>
              </span>
              <button aria-label="Delete rule" onClick={() => remove(r.id)} className="shrink-0 rounded p-1 text-slate-500 hover:bg-white/10 hover:text-red-400">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={add} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Field label="Type">
          <select
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
            className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200"
          >
            <option value="branch-silent">Branch silent</option>
            <option value="topic-silent">Topic silent</option>
            <option value="new-topic">New topic appears</option>
          </select>
        </Field>
        <Field label="Broker">
          <select
            value={form.brokerId || connected[0]?.id || ''}
            onChange={(e) => setForm((f) => ({ ...f, brokerId: e.target.value }))}
            className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200"
          >
            {connected.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            {connected.length === 0 && <option value="">no connected brokers</option>}
          </select>
        </Field>
        {form.type === 'branch-silent' && (
          <Field label="Branch path">
            <Input placeholder="plant/line1 (empty = whole namespace)" value={form.path} onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))} />
          </Field>
        )}
        {form.type === 'topic-silent' && (
          <Field label="Topic">
            <Input placeholder="plant/line1/temp" value={form.topic} onChange={(e) => setForm((f) => ({ ...f, topic: e.target.value }))} required />
          </Field>
        )}
        {form.type === 'new-topic' && (
          <Field label="Prefix (optional)">
            <Input placeholder="plant/" value={form.prefix} onChange={(e) => setForm((f) => ({ ...f, prefix: e.target.value }))} />
          </Field>
        )}
        {form.type !== 'new-topic' && (
          <Field label="Threshold (s)">
            <Input type="number" min="5" value={form.thresholdSec} onChange={(e) => setForm((f) => ({ ...f, thresholdSec: e.target.value }))} />
          </Field>
        )}
        <Field label="Webhook URL (optional)" className="col-span-2">
          <Input placeholder="https://hooks.example.com/…" value={form.webhookUrl} onChange={(e) => setForm((f) => ({ ...f, webhookUrl: e.target.value }))} />
        </Field>
        <div className="flex items-end">
          <Button type="submit" disabled={busy || connected.length === 0}>
            <Plus size={14} className="mr-1" /> Add rule
          </Button>
        </div>
      </form>

      {events.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Recent alerts</h3>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {events.map((e, i) => (
              <div key={i} className="flex items-center justify-between gap-2 rounded-lg bg-black/20 px-3 py-1.5 text-xs">
                <span className="min-w-0 truncate">
                  <span className={clsx('mr-2 font-semibold', e.status === 'firing' ? 'text-red-400' : e.status === 'resolved' ? 'text-emerald-400' : 'text-sky-400')}>
                    {e.status}
                  </span>
                  <span className="text-slate-300">{e.ruleName}</span>
                  <span className="ml-2 text-slate-500">{e.detail}</span>
                </span>
                <span className="shrink-0 text-[10px] text-slate-500">{formatDistanceToNow(e.ts, { addSuffix: true })}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
