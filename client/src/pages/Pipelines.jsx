import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Workflow, Boxes, Database, CircleDot, FileCheck2, Trash2, Plus, Play, Square,
  Eye, RefreshCw, AlertTriangle, CheckCircle2, Power, Pencil
} from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { socket } from '@/lib/socket';
import { api } from '@/lib/api';
import PageHeader from '@/components/PageHeader';
import ViewTab from '@/components/ViewTab';
import { Card, Button, Input, Field, Badge, EmptyState, HelpButton } from '@/components/ui';
import { formatDistanceToNow } from 'date-fns';

/**
 * Pipelines — Manifold's DataOps surface. Five tabs over the same live stream:
 *   Routes    source → transforms → target, with trie-backed dry-run
 *   Models    multi-source attributes merged into one object at a UNS path
 *   Historians  InfluxDB / Timebase connections pipelines+recorder write into
 *   Recorder  time-series capture to disk or a historian, plus replay
 *   Contracts locked payload schemas with drift violations
 */
export default function Pipelines() {
  const [tab, setTab] = useState('routes');
  const brokers = useStore((s) => s.brokers).filter((b) => b.status === 'connected');

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Pipelines"
        subtitle="route, reshape, contextualize, and record the live stream"
        actions={
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-xl border border-white/10">
              <ViewTab active={tab === 'routes'} onClick={() => setTab('routes')} icon={Workflow} label="Routes" />
              <ViewTab active={tab === 'models'} onClick={() => setTab('models')} icon={Boxes} label="Models" />
              <ViewTab active={tab === 'historians'} onClick={() => setTab('historians')} icon={Database} label="Historians" />
              <ViewTab active={tab === 'recorder'} onClick={() => setTab('recorder')} icon={CircleDot} label="Recorder" />
              <ViewTab active={tab === 'contracts'} onClick={() => setTab('contracts')} icon={FileCheck2} label="Contracts" />
            </div>
            <HelpButton title="How Pipelines work">
              <p>
                A <b>pipeline</b> reshapes your live message stream and sends the result somewhere else. It runs on the
                server as messages arrive. Nothing is stored unless you route it to a historian or the recorder.
              </p>
              <p>The five tabs each do one job.</p>

              <div className="space-y-2.5">
                <div>
                  <p className="font-semibold text-slate-100">Routes</p>
                  <p>The core building block. A route is <code>source → transforms → target</code>:</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    <li><b>Source</b>: a broker and a topic filter, for example <code>factory/+/temperature</code>.</li>
                    <li><b>Transforms</b>: an ordered chain. Re-path the topic, pick or rename fields, scale a number, flatten Sparkplug metrics, or wrap a value in a TVQ envelope.</li>
                    <li><b>Target</b>: publish to another broker topic, or write to a historian.</li>
                  </ul>
                  <p className="mt-1">
                    Example: read <code>plc/+/tempF</code>, scale it (multiply by <code>0.5556</code>, add <code>-17.78</code>) to
                    convert Fahrenheit to Celsius, then publish to <code>{'uns/{1}/tempC'}</code>. Use <b>Dry-run</b> to preview
                    the in and out mapping against live topics before you save.
                  </p>
                </div>
                <div>
                  <p className="font-semibold text-slate-100">Models</p>
                  <p>
                    Merge fields from several topics into one object at a clean UNS path. Example: combine
                    <code>line1/motor1/temp</code>, <code>line1/motor1/rpm</code>, and <code>line1/motor1/state</code> into a
                    single <code>line1/motor1</code> object shaped like <code>{'{ temp, rpm, state }'}</code>.
                  </p>
                </div>
                <div>
                  <p className="font-semibold text-slate-100">Historians</p>
                  <p>
                    Connections to a time-series database: InfluxDB, TimescaleDB, or Timebase. Routes and the recorder write
                    into them, and the <b>Trends</b> page reads them back. An on-prem historian that uses a self-signed
                    certificate needs "Allow self-signed TLS" turned on.
                  </p>
                </div>
                <div>
                  <p className="font-semibold text-slate-100">Recorder</p>
                  <p>
                    Capture a topic filter to a local file for later replay or charting. It works like a lightweight historian
                    with no database. Example: record <code>energy/#</code> for an hour, then scrub through it on Trends.
                  </p>
                </div>
                <div>
                  <p className="font-semibold text-slate-100">Contracts</p>
                  <p>
                    Declare the shape a topic&apos;s payload should have, for example <code>{'{ value: number, unit: string }'}</code>.
                    Manifold flags drift when a message stops matching, so you catch a firmware change that renamed a field.
                  </p>
                </div>
              </div>

              <p className="text-slate-400">
                A good first pipeline: a Route from <code>sensors/#</code>, one repath transform, into a TimescaleDB historian,
                then chart it on Trends.
              </p>
            </HelpButton>
          </div>
        }
      />
      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        {brokers.length === 0 && (
          <p className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            No connected brokers — sources and targets need at least one live MQTT connection.
          </p>
        )}
        {tab === 'routes' && <RoutesTab brokers={brokers} />}
        {tab === 'models' && <ModelsTab brokers={brokers} />}
        {tab === 'historians' && <HistoriansTab />}
        {tab === 'recorder' && <RecorderTab brokers={brokers} />}
        {tab === 'contracts' && <ContractsTab brokers={brokers} />}
      </div>
    </div>
  );
}

const brokerName = (brokers, id) => brokers.find((b) => b.id === id)?.name || (id ? `${id.slice(0, 8)}…` : '—');

// Poll for CONFIG (which changes rarely); live numbers arrive pushed over the
// socket. Hidden tabs don't poll at all — timers on background dashboards are
// wasted requests.
function usePoll(fn, ms = 5000, deps = []) {
  useEffect(() => {
    fn();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') fn();
    }, ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Live engine metrics pushed by the server every 2s over the shared socket. */
function useEngineMetrics(onMetrics) {
  useEffect(() => {
    socket.on('engine-metrics', onMetrics);
    return () => socket.off('engine-metrics', onMetrics);
  }, [onMetrics]);
}

// ---------------------------------------------------------------- Routes tab

const TRANSFORM_DEFAULTS = {
  repath: { type: 'repath', to: 'uns/{1-}' },
  pick: { type: 'pick', fields: [] },
  rename: { type: 'rename', map: {} },
  set: { type: 'set', values: {} },
  scale: { type: 'scale', field: '', mul: 1, add: 0 },
  numeric: { type: 'numeric', field: '' },
  sparkplugFlatten: { type: 'sparkplugFlatten' },
  envelope: { type: 'envelope' }
};

function RoutesTab({ brokers }) {
  const [data, setData] = useState({ routes: [], metrics: {} });
  const [historians, setHistorians] = useState([]);
  const [draft, setDraft] = useState(null); // null = closed editor
  const [preview, setPreview] = useState(null);

  const load = useCallback(() => {
    api.listPipelines().then(setData).catch(() => {});
    api.listHistorians().then((r) => setHistorians(r.historians)).catch(() => {});
  }, []);
  usePoll(load, 15000, [load]); // config only — numbers stream in below
  useEngineMetrics(
    useCallback((m) => setData((prev) => ({ ...prev, metrics: m.pipelines || prev.metrics, outbox: m.outbox || prev.outbox })), [])
  );

  const blank = () => ({
    name: '',
    enabled: true,
    source: { brokerId: brokers[0]?.id || '', filter: '' },
    transforms: [{ ...TRANSFORM_DEFAULTS.repath }],
    target: { type: 'mqtt', brokerId: brokers[0]?.id || '', retain: false }
  });

  const save = async () => {
    try {
      await api.savePipeline(draft);
      setDraft(null);
      setPreview(null);
      load();
      toast.success('Route saved');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const runPreview = async () => {
    try {
      setPreview(await api.previewPipeline(draft));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const toggle = async (route) => {
    await api.savePipeline({ ...route, enabled: !route.enabled }).catch(() => {});
    load();
  };

  return (
    <>
      {data.routes.length === 0 && !draft && (
        <EmptyState
          icon={Workflow}
          title="No pipeline routes yet"
          hint="A route consumes a topic filter, runs it through transforms (re-path, reshape, scale, flatten), and publishes to a broker or writes to a historian."
          action={<Button onClick={() => setDraft(blank())}>Create the first route</Button>}
        />
      )}

      {data.routes.map((route) => {
        const m = data.metrics[route.id] || {};
        return (
          <Card key={route.id} className={clsx('p-3', draft?.id === route.id && 'ring-1 ring-accent-500/40')}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-slate-100">{route.name || route.source.filter}</span>
                  <Badge status={route.enabled ? 'connected' : 'disconnected'}>{route.enabled ? 'running' : 'paused'}</Badge>
                </div>
                <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
                  {brokerName(brokers, route.source.brokerId)} · {route.source.filter} → {route.target.type === 'mqtt' ? `${brokerName(brokers, route.target.brokerId)} (mqtt${route.target.retain ? ', retained' : ''})` : `historian:${historians.find((h) => h.id === route.target.historianId)?.name || route.target.historianId.slice(0, 8)}`}
                  {route.transforms?.length ? ` · ${route.transforms.map((t) => t.type).join(' → ')}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-[11px] text-slate-400">
                <span title="matched / delivered / errors / loop-blocked" className="font-mono">
                  {m.matched || 0} in · {m.published || 0} out · <span className={m.errors ? 'text-rose-300' : ''}>{m.errors || 0} err</span>
                  {m.loopBlocked ? <span className="text-amber-300"> · {m.loopBlocked} loop</span> : null}
                </span>
                <button onClick={() => toggle(route)} title={route.enabled ? 'Pause' : 'Resume'} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10">
                  <Power size={13} />
                </button>
                <button
                  onClick={() => { setPreview(null); setDraft({ ...route, source: { ...route.source }, target: { ...route.target }, transforms: (route.transforms || []).map((t) => ({ ...t })) }); }}
                  title="Edit route"
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-accent-400"
                >
                  <Pencil size={13} />
                </button>
                <button
                  onClick={() => window.confirm(`Delete route "${route.name || route.id}"? It stops routing immediately.`) && api.deletePipeline(route.id).then(load)}
                  title="Delete route"
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-rose-300"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            {m.lastError && <p className="mt-1 truncate text-[11px] text-rose-300">{m.lastError}</p>}
          </Card>
        );
      })}

      {!draft && data.routes.length > 0 && (
        <Button variant="outline" onClick={() => setDraft(blank())}>
          <Plus size={14} className="mr-1" /> New route
        </Button>
      )}

      {draft && (
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">{draft.id ? 'Edit route' : 'New route'}</h3>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Field label="Name">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="normalize line1" />
            </Field>
            <Field label="Source broker">
              <BrokerSelect brokers={brokers} value={draft.source.brokerId} onChange={(v) => setDraft({ ...draft, source: { ...draft.source, brokerId: v } })} />
            </Field>
            <Field label="Source filter" className="col-span-2">
              <Input value={draft.source.filter} onChange={(e) => setDraft({ ...draft, source: { ...draft.source, filter: e.target.value } })} placeholder="raw/plant1/#" />
            </Field>
          </div>

          <h4 className="mb-1.5 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">Transforms (in order)</h4>
          <div className="space-y-2">
            {draft.transforms.map((t, i) => (
              <TransformRow
                key={i}
                t={t}
                onChange={(next) => setDraft({ ...draft, transforms: draft.transforms.map((x, j) => (j === i ? next : x)) })}
                onRemove={() => setDraft({ ...draft, transforms: draft.transforms.filter((_, j) => j !== i) })}
              />
            ))}
            <select
              value=""
              onChange={(e) => e.target.value && setDraft({ ...draft, transforms: [...draft.transforms, { ...TRANSFORM_DEFAULTS[e.target.value] }] })}
              className="rounded-lg border border-white/10 bg-surface-900 px-2 py-1.5 text-xs text-slate-300"
            >
              <option value="">+ add transform…</option>
              {Object.keys(TRANSFORM_DEFAULTS).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>

          <h4 className="mb-1.5 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">Target</h4>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Field label="Type">
              <select
                value={draft.target.type}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    target:
                      e.target.value === 'mqtt'
                        ? { type: 'mqtt', brokerId: brokers[0]?.id || '', retain: false }
                        : { type: 'historian', historianId: historians[0]?.id || '' }
                  })
                }
                className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200"
              >
                <option value="mqtt">Publish to broker</option>
                <option value="historian">Write to historian</option>
              </select>
            </Field>
            {draft.target.type === 'mqtt' ? (
              <>
                <Field label="Broker">
                  <BrokerSelect brokers={brokers} value={draft.target.brokerId} onChange={(v) => setDraft({ ...draft, target: { ...draft.target, brokerId: v } })} />
                </Field>
                <label className="flex items-end gap-2 pb-2 text-xs text-slate-300">
                  <input type="checkbox" checked={draft.target.retain} onChange={(e) => setDraft({ ...draft, target: { ...draft.target, retain: e.target.checked } })} />
                  retain
                </label>
              </>
            ) : (
              <Field label="Historian">
                <select
                  value={draft.target.historianId}
                  onChange={(e) => setDraft({ ...draft, target: { ...draft.target, historianId: e.target.value } })}
                  className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200"
                >
                  {historians.length === 0 && <option value="">configure one in the Historians tab</option>}
                  {historians.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name || h.url} ({h.type})
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Button variant="outline" onClick={runPreview} disabled={!draft.source.filter}>
              <Eye size={14} className="mr-1" /> Dry-run preview
            </Button>
            <Button onClick={save} disabled={!draft.source.filter || (draft.target.type === 'historian' && !draft.target.historianId)}>
              {draft.id ? 'Save changes' : 'Save route'}
            </Button>
            <Button variant="ghost" onClick={() => { setDraft(null); setPreview(null); }}>
              Cancel
            </Button>
          </div>

          {preview && (
            <div className="mt-3 rounded-xl border border-white/10 bg-surface-950/60 p-3">
              <p className="mb-2 text-xs text-slate-400">
                Matches <span className="font-semibold text-slate-200">{preview.matchCount?.toLocaleString?.() ?? 0}</span> observed topics
                {preview.error && <span className="text-rose-300"> · {preview.error}</span>}
              </p>
              <div className="max-h-56 space-y-1 overflow-y-auto font-mono text-[11px]">
                {(preview.rows || []).map((r, i) => (
                  <div key={i} className={clsx('rounded-lg px-2 py-1', r.loop ? 'bg-rose-500/10' : 'bg-black/20')}>
                    <span className="text-slate-400">{r.inTopic}</span>
                    <span className="mx-1 text-slate-600">→</span>
                    {r.dropped ? (
                      <span className="text-amber-300">dropped by transform</span>
                    ) : (
                      <span className={r.loop ? 'text-rose-300' : 'text-emerald-300'}>{r.outTopic}{r.loop ? ' (would loop — blocked)' : ''}</span>
                    )}
                    {!r.dropped && (
                      <div className="truncate text-slate-500">{JSON.stringify(r.outPayload)}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

function TransformRow({ t, onChange, onRemove }) {
  const input = (props) => (
    <input
      {...props}
      className="rounded-lg border border-white/10 bg-surface-950/60 px-2 py-1 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none"
    />
  );
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-black/20 px-2 py-1.5 text-xs">
      <span className="rounded bg-accent-500/15 px-1.5 py-0.5 font-mono text-[10px] text-accent-300">{t.type}</span>
      {t.type === 'repath' && input({ value: t.to, style: { width: 260 }, placeholder: 'uns/{1}/{3-}  ({n}=segment, {n-}=tail, {topic})', onChange: (e) => onChange({ ...t, to: e.target.value }) })}
      {t.type === 'pick' && input({ value: (t.fields || []).join(','), style: { width: 220 }, placeholder: 'field1,field2', onChange: (e) => onChange({ ...t, fields: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }) })}
      {t.type === 'rename' && input({ value: Object.entries(t.map || {}).map(([a, b]) => `${a}:${b}`).join(','), style: { width: 220 }, placeholder: 'old:new,old2:new2', onChange: (e) => onChange({ ...t, map: Object.fromEntries(e.target.value.split(',').map((p) => p.split(':').map((s) => s.trim())).filter((p) => p.length === 2 && p[0])) }) })}
      {t.type === 'set' && input({ value: JSON.stringify(t.values || {}), style: { width: 220 }, placeholder: '{"site":"emmeloord"}', onChange: (e) => { try { onChange({ ...t, values: JSON.parse(e.target.value || '{}') }); } catch { /* keep typing */ } } })}
      {t.type === 'scale' && (
        <>
          {input({ value: t.field || '', style: { width: 90 }, placeholder: 'field (opt)', onChange: (e) => onChange({ ...t, field: e.target.value }) })}
          ×{input({ value: t.mul, style: { width: 60 }, onChange: (e) => onChange({ ...t, mul: e.target.value }) })}
          +{input({ value: t.add, style: { width: 60 }, onChange: (e) => onChange({ ...t, add: e.target.value }) })}
        </>
      )}
      {t.type === 'numeric' && input({ value: t.field || '', style: { width: 120 }, placeholder: 'field (optional)', onChange: (e) => onChange({ ...t, field: e.target.value }) })}
      {t.type === 'sparkplugFlatten' && <span className="text-slate-500">metrics[] → {'{name: value}'}</span>}
      {t.type === 'envelope' && <span className="text-slate-500">wrap as {'{v, t, q}'} (value, source ts, quality)</span>}
      <button onClick={onRemove} className="ml-auto rounded p-1 text-slate-500 hover:bg-white/10 hover:text-rose-300">
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function BrokerSelect({ brokers, value, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200">
      {brokers.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
      {brokers.length === 0 && <option value="">no connected brokers</option>}
    </select>
  );
}

// ---------------------------------------------------------------- Models tab

function ModelsTab({ brokers }) {
  const [data, setData] = useState({ models: [], status: {} });
  const [draft, setDraft] = useState(null);
  const load = useCallback(() => api.listModels().then(setData).catch(() => {}), []);
  usePoll(load, 5000, [load]);

  const blank = () => ({
    name: '',
    enabled: true,
    publishMode: 'on-change',
    intervalMs: 5000,
    target: { brokerId: brokers[0]?.id || '', topic: '', retain: true },
    attributes: [{ name: '', source: { brokerId: brokers[0]?.id || '', topic: '', field: '' } }]
  });

  const save = async () => {
    try {
      const clean = {
        ...draft,
        attributes: draft.attributes
          .filter((a) => a.name && a.source.topic)
          .map((a) => ({ name: a.name, source: { brokerId: a.source.brokerId, topic: a.source.topic, ...(a.source.field ? { field: a.source.field } : {}) } }))
      };
      await api.saveModel(clean);
      setDraft(null);
      load();
      toast.success('Model saved');
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <>
      {data.models.length === 0 && !draft && (
        <EmptyState
          icon={Boxes}
          title="No models yet"
          hint="A model binds attributes from many raw topics (even across brokers) and publishes them as one merged object at a clean UNS path — ten raw topics become one Pump-7."
          action={<Button onClick={() => setDraft(blank())}>Create the first model</Button>}
        />
      )}
      {data.models.map((m) => {
        const s = data.status[m.id] || {};
        return (
          <Card key={m.id} className={clsx('p-3', draft?.id === m.id && 'ring-1 ring-accent-500/40')}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-slate-100">{m.name || m.target.topic}</span>
                  <Badge status={m.enabled ? 'connected' : 'disconnected'}>{m.publishMode}</Badge>
                </div>
                <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
                  {m.attributes.length} attribute(s) → {brokerName(brokers, m.target.brokerId)} · {m.target.topic}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-[11px] text-slate-400">
                <span className="font-mono">
                  {s.boundAttributes ?? 0}/{m.attributes.length} bound · {s.publishes || 0} pub
                  {s.errors ? <span className="text-rose-300"> · {s.errors} err</span> : null}
                </span>
                <button
                  onClick={() => setDraft({ ...m, target: { ...m.target }, attributes: m.attributes.map((a) => ({ name: a.name, source: { ...a.source, field: a.source.field || '' } })) })}
                  title="Edit model"
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-accent-400"
                >
                  <Pencil size={13} />
                </button>
                <button onClick={() => window.confirm(`Delete model "${m.name || m.id}"?`) && api.deleteModel(m.id).then(load)} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-rose-300">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            {s.lastError && <p className="mt-1 text-[11px] text-rose-300">{s.lastError}</p>}
          </Card>
        );
      })}
      {!draft && data.models.length > 0 && (
        <Button variant="outline" onClick={() => setDraft(blank())}>
          <Plus size={14} className="mr-1" /> New model
        </Button>
      )}
      {draft && (
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">{draft.id ? 'Edit model' : 'New model'}</h3>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Field label="Name">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Pump-7" />
            </Field>
            <Field label="Target broker">
              <BrokerSelect brokers={brokers} value={draft.target.brokerId} onChange={(v) => setDraft({ ...draft, target: { ...draft.target, brokerId: v } })} />
            </Field>
            <Field label="Target topic (UNS path)">
              <Input value={draft.target.topic} onChange={(e) => setDraft({ ...draft, target: { ...draft.target, topic: e.target.value } })} placeholder="site/area/line/pump7" />
            </Field>
            <Field label="Publish">
              <select
                value={draft.publishMode}
                onChange={(e) => setDraft({ ...draft, publishMode: e.target.value })}
                className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200"
              >
                <option value="on-change">on change (debounced)</option>
                <option value="interval">on interval</option>
              </select>
            </Field>
            {draft.publishMode === 'interval' && (
              <Field label="Interval (ms)">
                <Input type="number" value={draft.intervalMs} onChange={(e) => setDraft({ ...draft, intervalMs: e.target.value })} />
              </Field>
            )}
          </div>
          <h4 className="mb-1.5 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">Attributes</h4>
          <div className="space-y-2">
            {draft.attributes.map((a, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-black/20 px-2 py-1.5">
                <Input value={a.name} onChange={(e) => setDraft({ ...draft, attributes: draft.attributes.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="rpm" className="w-28" />
                <BrokerSelect brokers={brokers} value={a.source.brokerId} onChange={(v) => setDraft({ ...draft, attributes: draft.attributes.map((x, j) => (j === i ? { ...x, source: { ...x.source, brokerId: v } } : x)) })} />
                <Input value={a.source.topic} onChange={(e) => setDraft({ ...draft, attributes: draft.attributes.map((x, j) => (j === i ? { ...x, source: { ...x.source, topic: e.target.value } } : x)) })} placeholder="raw/pump7/rpm" className="min-w-56 flex-1" />
                <Input value={a.source.field} onChange={(e) => setDraft({ ...draft, attributes: draft.attributes.map((x, j) => (j === i ? { ...x, source: { ...x.source, field: e.target.value } } : x)) })} placeholder="field (opt)" className="w-28" />
                <button onClick={() => setDraft({ ...draft, attributes: draft.attributes.filter((_, j) => j !== i) })} className="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-rose-300">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, attributes: [...draft.attributes, { name: '', source: { brokerId: brokers[0]?.id || '', topic: '', field: '' } }] })}>
              <Plus size={12} className="mr-1" /> attribute
            </Button>
          </div>
          <div className="mt-4 flex gap-2">
            <Button onClick={save} disabled={!draft.target.topic || !draft.attributes.some((a) => a.name && a.source.topic)}>{draft.id ? 'Save changes' : 'Save model'}</Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Historians tab

const BLANK_HISTORIAN = { type: 'influxdb', name: '', url: '', org: '', bucket: '', token: '', measurement: '', dataset: '', writePath: '', apiKey: '', host: '', port: '', database: '', user: '', password: '', table: '', ssl: false, sslInsecure: false, sslRootCert: '', dropPolicy: 'newest' };

function HistoriansTab() {
  const [data, setData] = useState({ historians: [], types: [] });
  const [outbox, setOutbox] = useState({});
  const [form, setForm] = useState(BLANK_HISTORIAN);
  const [editingId, setEditingId] = useState(null);
  const [testing, setTesting] = useState(null); // id -> result
  const load = useCallback(() => api.listHistorians().then(setData).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load]);
  useEngineMetrics(useCallback((m) => m.outbox && setOutbox(m.outbox), []));

  const save = async () => {
    try {
      const payload = { ...form };
      if (editingId) {
        payload.id = editingId;
        // The list endpoint never echoes secrets — an empty field means "keep
        // the stored one", so omit the key entirely (the server preserves
        // stored secrets only for omitted keys).
        for (const k of ['token', 'apiKey', 'password']) {
          if (!payload[k]) delete payload[k];
        }
      }
      await api.saveHistorian(payload);
      if (editingId) {
        setEditingId(null);
        setForm(BLANK_HISTORIAN);
      } else {
        setForm((f) => ({ ...f, name: '', url: '', org: '', bucket: '', token: '', dataset: '' }));
      }
      load();
      toast.success('Historian saved');
    } catch (e) {
      toast.error(e.message);
    }
  };

  // Load a historian into the form; secret fields stay blank (= unchanged).
  const edit = (h) => {
    setForm({
      ...BLANK_HISTORIAN,
      type: h.type,
      name: h.name || '',
      url: h.url || '',
      org: h.org || '',
      bucket: h.bucket || '',
      measurement: h.measurement || '',
      dataset: h.dataset || '',
      writePath: h.writePath || '',
      host: h.host || '',
      port: h.port || '',
      database: h.database || '',
      user: h.user || '',
      table: h.table || '',
      ssl: Boolean(h.ssl),
      sslInsecure: Boolean(h.sslInsecure),
      sslRootCert: h.sslRootCert || '',
      dropPolicy: h.dropPolicy || 'newest'
    });
    setEditingId(h.id);
  };

  const test = async (id) => {
    setTesting({ id, state: 'running' });
    try {
      await api.testHistorian(id);
      setTesting({ id, state: 'ok' });
    } catch (e) {
      setTesting({ id, state: 'fail', error: e.message });
    }
  };

  return (
    <>
      {data.historians.map((h) => (
        <Card key={h.id} className={clsx('p-3', editingId === h.id && 'ring-1 ring-accent-500/40')}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-slate-100">{h.name || h.url}</span>
                <Badge>{h.type}</Badge>
              </div>
              <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
                {h.type === 'timescaledb' ? `${h.host}:${h.port || 5432}/${h.database} · table=${h.table || 'manifold_samples'}` : h.url}
                {h.type === 'influxdb' && ` · org=${h.org} bucket=${h.bucket}`}
                {h.type === 'timebase' && ` · dataset=${h.dataset}`}
              </p>
              {outbox[h.id] && (
                <p className="mt-0.5 text-[11px]">
                  <span className="text-slate-500">store-and-forward: </span>
                  <span className="font-mono text-slate-400">
                    {outbox[h.id].written.toLocaleString()} written · {outbox[h.id].queued} queued
                    {outbox[h.id].spillBytes > 0 && (
                      <span className="text-amber-300"> · {(outbox[h.id].spillBytes / 1024).toFixed(1)} KB spilled to disk</span>
                    )}
                    {outbox[h.id].dropped > 0 && <span className="text-rose-300"> · {outbox[h.id].dropped} dropped</span>}
                  </span>
                  {outbox[h.id].lastError && <span className="ml-1 text-rose-300">· {outbox[h.id].lastError}</span>}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {testing?.id === h.id && testing.state === 'ok' && <CheckCircle2 size={15} className="text-emerald-400" />}
              {testing?.id === h.id && testing.state === 'fail' && (
                <span className="flex items-center gap-1 text-[11px] text-rose-300">
                  <AlertTriangle size={13} /> {testing.error}
                </span>
              )}
              <Button size="sm" variant="outline" onClick={() => test(h.id)} disabled={testing?.id === h.id && testing.state === 'running'}>
                <RefreshCw size={12} className={clsx('mr-1', testing?.id === h.id && testing.state === 'running' && 'animate-spin')} /> Test write
              </Button>
              <button onClick={() => edit(h)} title="Edit historian" className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-accent-400">
                <Pencil size={13} />
              </button>
              <button onClick={() => window.confirm(`Remove historian "${h.name || h.url}"?\n\nThis deletes the stored connection, including its credentials. Data already written to the database is not affected.`) && api.deleteHistorian(h.id).then(load)} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-rose-300">
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        </Card>
      ))}

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">{editingId ? 'Edit historian' : 'Add historian'}</h3>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Field label="Type">
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200">
              <option value="influxdb">InfluxDB v2</option>
              <option value="timebase">Timebase historian (Flow Software)</option>
              <option value="timescaledb">TimescaleDB / PostgreSQL</option>
            </select>
          </Field>
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="plant historian" />
          </Field>
          <Field label="When offline buffer is full">
            <select value={form.dropPolicy} onChange={(e) => setForm({ ...form, dropPolicy: e.target.value })} className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200">
              <option value="newest">Drop newest (keep outage start)</option>
              <option value="oldest">Drop oldest (keep latest data)</option>
            </select>
          </Field>
          {form.type !== 'timescaledb' && (
            <Field label="URL" className="col-span-2">
              <Input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder={
                  form.type === 'influxdb' ? 'http://influx-host:8086' : 'http://historian-host:4511'
                }
              />
            </Field>
          )}
          {form.type === 'timescaledb' && (
            <>
              <Field label="Host">
                <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="tsdb-host" />
              </Field>
              <Field label="Port">
                <Input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} placeholder="5432" />
              </Field>
              <Field label="Database">
                <Input value={form.database} onChange={(e) => setForm({ ...form, database: e.target.value })} />
              </Field>
              <Field label="User">
                <Input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
              </Field>
              <Field label="Password">
                <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={editingId ? 'unchanged' : undefined} />
              </Field>
              <Field label="Table (optional)">
                <Input value={form.table} onChange={(e) => setForm({ ...form, table: e.target.value })} placeholder="manifold_samples" />
              </Field>
              <label className="flex items-end gap-2 pb-2 text-xs text-slate-300">
                <input type="checkbox" checked={form.ssl} onChange={(e) => setForm({ ...form, ssl: e.target.checked })} /> SSL
              </label>
            </>
          )}
          {form.type === 'influxdb' && (
            <>
              <Field label="Org">
                <Input value={form.org} onChange={(e) => setForm({ ...form, org: e.target.value })} />
              </Field>
              <Field label="Bucket">
                <Input value={form.bucket} onChange={(e) => setForm({ ...form, bucket: e.target.value })} />
              </Field>
              <Field label="Token">
                <Input type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder={editingId ? 'unchanged' : undefined} />
              </Field>
              <Field label="Measurement (optional)">
                <Input value={form.measurement} onChange={(e) => setForm({ ...form, measurement: e.target.value })} placeholder="manifold" />
              </Field>
            </>
          )}
          {form.type === 'timebase' && (
            <>
              <Field label="Dataset">
                <Input value={form.dataset} onChange={(e) => setForm({ ...form, dataset: e.target.value })} placeholder="Manifold" />
              </Field>
              <Field label="API key (optional)">
                <Input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={editingId ? 'unchanged' : undefined} />
              </Field>
              <Field label="Write path (optional)" className="col-span-2">
                <Input value={form.writePath} onChange={(e) => setForm({ ...form, writePath: e.target.value })} placeholder="default: /api/datasets/{dataset}/data" />
              </Field>
            </>
          )}
        </div>
        <div className="mt-3 rounded-lg border border-white/5 bg-surface-950/40 p-3">
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={form.sslInsecure} onChange={(e) => setForm({ ...form, sslInsecure: e.target.checked })} />
            Allow self-signed TLS certificate (skip verification)
          </label>
          <p className="mt-1 text-[11px] leading-snug text-slate-500">
            Needed for on-prem historians with a self-signed certificate — e.g. a default Timebase install, whose HTTP
            port 307-redirects to a self-signed HTTPS listener. Leave off for internet-facing or properly-certificated
            targets{form.type === 'timescaledb' ? ' (applies only when SSL is enabled above)' : ''}.
          </p>
          {!form.sslInsecure && (
            <Field label="CA certificate (PEM, optional)" className="mt-2">
              <textarea
                value={form.sslRootCert}
                onChange={(e) => setForm({ ...form, sslRootCert: e.target.value })}
                rows={3}
                placeholder="-----BEGIN CERTIFICATE-----"
                className="w-full rounded-lg border border-white/10 bg-surface-950/60 px-3 py-2 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:border-accent-500/60 focus:outline-none"
              />
            </Field>
          )}
        </div>
        {form.type === 'timebase' && (
          <p className="mt-2 text-[11px] leading-snug text-slate-500">
            Timebase writes TVQ samples into the dataset (auto-created on first write; points older than a tag's newest
            sample are ignored by the historian). Timebase also ingests MQTT/Sparkplug natively — pointing its collector
            at this broker, or at a pipeline's output namespace, is an equally good path.
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <Button
            onClick={save}
            disabled={
              form.type === 'timescaledb'
                ? !form.host || !form.database || !form.user
                : !form.url ||
                  (form.type === 'influxdb' && (!form.org || !form.bucket)) ||
                  (form.type === 'timebase' && !form.dataset)
            }
          >
            {editingId ? 'Save changes' : <><Plus size={14} className="mr-1" /> Add historian</>}
          </Button>
          {editingId && (
            <Button variant="ghost" onClick={() => { setEditingId(null); setForm(BLANK_HISTORIAN); }}>
              Cancel
            </Button>
          )}
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- Recorder tab

function RecorderTab({ brokers }) {
  const [data, setData] = useState({ recordings: [], replay: { running: false } });
  const [historians, setHistorians] = useState([]);
  const [form, setForm] = useState({ name: '', brokerId: '', filter: '', targetType: 'file', historianId: '' });
  const [peek, setPeek] = useState(null); // { id, points }
  const [replayForm, setReplayForm] = useState({ speed: 1, loop: false, topicPrefix: 'replay/' });

  const load = useCallback(() => {
    api.listRecordings().then(setData).catch(() => {});
    api.listHistorians().then((r) => setHistorians(r.historians)).catch(() => {});
  }, []);
  usePoll(load, 4000, [load]);

  const save = async () => {
    try {
      await api.saveRecording({
        name: form.name || null,
        brokerId: form.brokerId || brokers[0]?.id,
        filter: form.filter,
        target: form.targetType === 'historian' ? { type: 'historian', historianId: form.historianId } : { type: 'file' }
      });
      setForm((f) => ({ ...f, name: '', filter: '' }));
      load();
      toast.success('Recording started');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const replay = async (rec) => {
    try {
      await api.startReplay({ recordingId: rec.id, brokerId: rec.brokerId, ...replayForm, speed: Number(replayForm.speed) || 1 });
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <>
      {data.replay.running && (
        <Card className="border-accent-500/30 p-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm text-slate-200">
              <Play size={14} className="text-accent-300" /> Replaying · {data.replay.index}/{data.replay.total} · {data.replay.published} published
              {data.replay.errors > 0 && <span className="text-rose-300">· {data.replay.errors} errors</span>}
            </span>
            <Button size="sm" variant="outline" onClick={() => api.stopReplay().then(load)}>
              <Square size={12} className="mr-1" /> Stop
            </Button>
          </div>
        </Card>
      )}

      {data.recordings.length === 0 && (
        <EmptyState
          icon={CircleDot}
          title="No recordings"
          hint="A recording captures every message under a filter as a time series — to a local file (replayable) or straight into a historian."
        />
      )}
      {data.recordings.map((rec) => (
        <Card key={rec.id} className="p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-slate-100">{rec.name || rec.filter}</span>
                <Badge status={rec.enabled && !rec.status.full ? 'connected' : 'disconnected'}>
                  {rec.status.full ? 'full' : rec.enabled ? 'recording' : 'paused'}
                </Badge>
                <Badge>{rec.target?.type === 'historian' ? 'historian' : 'file'}</Badge>
              </div>
              <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
                {brokerName(brokers, rec.brokerId)} · {rec.filter} · {rec.status.points.toLocaleString()} pts
                {rec.target?.type !== 'historian' && ` · ${(rec.status.bytes / 1024).toFixed(1)} KB`}
                {rec.status.lastTs ? ` · last ${formatDistanceToNow(rec.status.lastTs, { addSuffix: true })}` : ''}
              </p>
              {rec.status.lastError && <p className="mt-0.5 text-[11px] text-amber-300">{rec.status.lastError}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {rec.target?.type !== 'historian' && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => api.recordingData(rec.id, { limit: 20 }).then((d) => setPeek({ id: rec.id, ...d }))}>
                    <Eye size={12} className="mr-1" /> Peek
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => replay(rec)} disabled={data.replay.running || !rec.status.points}>
                    <Play size={12} className="mr-1" /> Replay
                  </Button>
                </>
              )}
              <button onClick={() => window.confirm(`Delete recording "${rec.name || rec.id}"?\n\nThe captured data file is discarded and cannot be recovered.`) && api.deleteRecording(rec.id).then(load)} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-rose-300">
                <Trash2 size={13} />
              </button>
            </div>
          </div>
          {peek?.id === rec.id && (
            <div className="mt-2 max-h-40 overflow-y-auto rounded-lg bg-black/20 p-2 font-mono text-[11px] text-slate-300">
              {peek.points.map((p, i) => (
                <div key={i} className="truncate">
                  {new Date(p.t).toLocaleTimeString()} · {p.topic} · {typeof p.v === 'object' ? JSON.stringify(p.v) : String(p.v)}
                </div>
              ))}
              {peek.points.length === 0 && <span className="text-slate-500">no points yet</span>}
            </div>
          )}
        </Card>
      ))}

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">New recording</h3>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="line1 capture" />
          </Field>
          <Field label="Broker">
            <BrokerSelect brokers={brokers} value={form.brokerId || brokers[0]?.id || ''} onChange={(v) => setForm({ ...form, brokerId: v })} />
          </Field>
          <Field label="Filter">
            <Input value={form.filter} onChange={(e) => setForm({ ...form, filter: e.target.value })} placeholder="plant/line1/#" />
          </Field>
          <Field label="Target">
            <select value={form.targetType} onChange={(e) => setForm({ ...form, targetType: e.target.value })} className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200">
              <option value="file">Local file (replayable)</option>
              <option value="historian">Historian</option>
            </select>
          </Field>
          {form.targetType === 'historian' && (
            <Field label="Historian">
              <select value={form.historianId} onChange={(e) => setForm({ ...form, historianId: e.target.value })} className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200">
                <option value="">select…</option>
                {historians.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name || h.url} ({h.type})
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button onClick={save} disabled={!form.filter || (form.targetType === 'historian' && !form.historianId)}>
            <CircleDot size={14} className="mr-1" /> Start recording
          </Button>
          <span className="text-[11px] text-slate-500">Replay options:</span>
          <label className="flex items-center gap-1 text-[11px] text-slate-400">
            speed ×
            <input value={replayForm.speed} onChange={(e) => setReplayForm({ ...replayForm, speed: e.target.value })} className="w-14 rounded border border-white/10 bg-surface-950/60 px-1.5 py-0.5 font-mono text-[11px] text-slate-200" />
          </label>
          <label className="flex items-center gap-1 text-[11px] text-slate-400">
            <input type="checkbox" checked={replayForm.loop} onChange={(e) => setReplayForm({ ...replayForm, loop: e.target.checked })} /> loop
          </label>
          <label className="flex items-center gap-1 text-[11px] text-slate-400">
            prefix
            <input value={replayForm.topicPrefix} onChange={(e) => setReplayForm({ ...replayForm, topicPrefix: e.target.value })} className="w-24 rounded border border-white/10 bg-surface-950/60 px-1.5 py-0.5 font-mono text-[11px] text-slate-200" />
          </label>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- Contracts tab

function ContractsTab({ brokers }) {
  const [data, setData] = useState({ contracts: [], counters: {} });
  const [violations, setViolations] = useState([]);
  const [form, setForm] = useState({ brokerId: '', topic: '', name: '' });
  const [inferred, setInferred] = useState(null); // { topic, schema }

  const load = useCallback(() => {
    api.listContracts().then(setData).catch(() => {});
    api.contractViolations(100).then((r) => setViolations(r.violations)).catch(() => {});
  }, []);
  usePoll(load, 5000, [load]);

  const infer = async () => {
    try {
      setInferred(await api.inferContract(form.brokerId || brokers[0]?.id, form.topic));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const lock = async () => {
    try {
      await api.saveContract({
        name: form.name || null,
        brokerId: form.brokerId || brokers[0]?.id,
        filter: form.topic,
        schema: inferred.schema
      });
      setInferred(null);
      setForm((f) => ({ ...f, topic: '', name: '' }));
      load();
      toast.success('Contract locked');
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <>
      {data.contracts.map((c) => {
        const k = data.counters[c.id] || {};
        return (
          <Card key={c.id} className="p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-slate-100">{c.name || c.filter}</span>
                  <Badge status={k.violations ? 'error' : 'connected'}>{k.violations ? `${k.violations} violations` : 'conforming'}</Badge>
                </div>
                <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
                  {brokerName(brokers, c.brokerId)} · {c.filter} · {k.checked || 0} checked · locked {c.lockedAt ? formatDistanceToNow(new Date(c.lockedAt), { addSuffix: true }) : ''}
                </p>
              </div>
              <button onClick={() => window.confirm(`Delete the contract for "${c.filter || c.id}"?`) && api.deleteContract(c.id).then(load)} className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-rose-300">
                <Trash2 size={13} />
              </button>
            </div>
          </Card>
        );
      })}

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">Lock a payload contract</h3>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Field label="Broker">
            <BrokerSelect brokers={brokers} value={form.brokerId || brokers[0]?.id || ''} onChange={(v) => setForm({ ...form, brokerId: v })} />
          </Field>
          <Field label="Topic (or filter after inferring)" className="col-span-2">
            <Input value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} placeholder="plant/line1/filler/temperature" />
          </Field>
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="filler temp shape" />
          </Field>
        </div>
        <div className="mt-3 flex gap-2">
          <Button variant="outline" onClick={infer} disabled={!form.topic}>
            Infer schema from latest payload
          </Button>
          {inferred && <Button onClick={lock}>Lock contract</Button>}
        </div>
        {inferred && (
          <pre className="mono mt-3 max-h-48 overflow-auto rounded-xl border border-white/10 bg-surface-950/60 p-3 text-[11px] text-slate-300">
            {JSON.stringify(inferred.schema, null, 2)}
          </pre>
        )}
      </Card>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Recent violations</h3>
        {violations.length === 0 && <p className="text-xs text-slate-500">No drift detected.</p>}
        <div className="space-y-1">
          {violations.map((v, i) => (
            <div key={i} className="rounded-lg bg-black/20 px-3 py-1.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-mono text-slate-300">{v.topic}</span>
                <span className="text-[10px] text-slate-500">{formatDistanceToNow(v.ts, { addSuffix: true })}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-slate-400">
                {v.problems.map((p, j) => (
                  <span key={j} className="mr-2">
                    <span className={p.kind === 'type-changed' ? 'text-amber-300' : p.kind === 'missing-field' ? 'text-rose-300' : 'text-sky-300'}>
                      {p.kind}
                    </span>{' '}
                    <span className="font-mono">{p.path}</span>
                    {p.expected && ` (expected ${p.expected}${p.got ? `, got ${p.got}` : ''})`}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
