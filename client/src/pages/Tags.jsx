import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronRight, ChevronDown, FolderClosed, CircleDot, Tags as TagsIcon, Trash2,
  Plus, Upload, Radio, Cpu, X, Pencil
} from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import PageHeader from '@/components/PageHeader';
import { Card, Button, Input, Field, Badge, EmptyState } from '@/components/ui';
import { formatDistanceToNow } from 'date-fns';

/**
 * Tags — browse device tags across the drivers Manifold already speaks (OPC UA
 * address space, Sparkplug device registry, MQTT topic trie), select them, and
 * bind them into the UNS: connectivity → selection → publish in one gesture.
 *
 * Bindings are read-only by design: they subscribe/monitor and republish;
 * nothing here writes to a device.
 */
export default function Tags() {
  const brokers = useStore((s) => s.brokers).filter((b) => b.status === 'connected');
  const [sources, setSources] = useState([]);
  const [source, setSource] = useState(null); // { type, id, label }
  const [selection, setSelection] = useState(new Map()); // address -> { name, meta }
  const [bindings, setBindings] = useState({ bindings: [], status: {} });
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingBinding, setEditingBinding] = useState(null);
  const [csvOpen, setCsvOpen] = useState(false);

  const loadSources = useCallback(() => {
    api.tagSources().then((r) => {
      setSources(r.sources);
      setSource((cur) => cur && r.sources.some((s) => s.type === cur.type && s.id === cur.id) ? cur : r.sources[0] || null);
    }).catch(() => {});
  }, []);
  const loadBindings = useCallback(() => api.listBindings().then(setBindings).catch(() => {}), []);

  useEffect(() => {
    loadSources();
    loadBindings();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') loadBindings();
    }, 5000);
    return () => clearInterval(t);
  }, [loadSources, loadBindings]);

  const toggleTag = (node) => {
    setSelection((prev) => {
      const next = new Map(prev);
      if (next.has(node.address)) next.delete(node.address);
      else next.set(node.address, { name: node.name, meta: node.meta || {} });
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Tags"
        subtitle="browse device tags, bind them into the UNS"
        actions={
          <div className="flex items-center gap-2">
            <select
              value={source ? `${source.type}:${source.id}` : ''}
              onChange={(e) => {
                const s = sources.find((x) => `${x.type}:${x.id}` === e.target.value);
                setSource(s || null);
                setSelection(new Map());
              }}
              className="rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-200 focus:outline-none"
            >
              {sources.length === 0 && <option value="">no browsable sources</option>}
              {sources.map((s) => (
                <option key={`${s.type}:${s.id}`} value={`${s.type}:${s.id}`}>
                  {s.label}
                </option>
              ))}
            </select>
            {source?.type === 'opcua' && (
              <Button variant="outline" onClick={() => setCsvOpen(true)}>
                <Upload size={14} className="mr-1" /> Import CSV
              </Button>
            )}
            <Button onClick={() => setWizardOpen(true)} disabled={selection.size === 0 && source?.type !== 'sparkplug'}>
              <Plus size={14} className="mr-1" /> Add to UNS {selection.size > 0 && `(${selection.size})`}
            </Button>
          </div>
        }
      />

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          {!source && (
            <EmptyState
              icon={TagsIcon}
              title="Nothing to browse yet"
              hint="Connect an OPC UA server or an MQTT broker (Sparkplug devices appear automatically) and its tags become browsable here."
            />
          )}
          {source && <TagTree key={`${source.type}:${source.id}`} source={source} selection={selection} onToggle={toggleTag} />}
        </div>

        <aside className="flex w-96 shrink-0 flex-col gap-3 overflow-y-auto border-l border-white/5 bg-surface-900/30 p-3">
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Selected tags ({selection.size})
            </h3>
            {selection.size === 0 && <p className="text-xs text-slate-500">Tick tags in the tree, then “Add to UNS”.</p>}
            <div className="max-h-48 space-y-0.5 overflow-y-auto">
              {[...selection.entries()].map(([address, t]) => (
                <div key={address} className="flex items-center justify-between gap-2 rounded bg-black/20 px-2 py-1 text-[11px]">
                  <span className="min-w-0 truncate font-mono text-slate-300" title={address}>{t.name}</span>
                  <button onClick={() => setSelection((p) => { const n = new Map(p); n.delete(address); return n; })} className="text-slate-500 hover:text-rose-300">
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Bindings</h3>
            {bindings.bindings.length === 0 && <p className="text-xs text-slate-500">No bindings yet.</p>}
            <div className="space-y-1.5">
              {bindings.bindings.map((b) => {
                const s = bindings.status[b.id] || {};
                return (
                  <div key={b.id} className={clsx('rounded-lg bg-black/20 px-2.5 py-2', editingBinding?.id === b.id && 'ring-1 ring-accent-500/40')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-xs font-semibold text-slate-200">{b.name || b.id.slice(0, 8)}</span>
                      <span className="flex items-center gap-1.5">
                        <Badge>{b.source.type}→{b.target.mode}</Badge>
                        <button aria-label="Edit binding" onClick={() => setEditingBinding(b)} className="rounded p-0.5 text-slate-500 hover:text-accent-400">
                          <Pencil size={12} />
                        </button>
                        <button onClick={() => api.deleteBinding(b.id).then(loadBindings)} className="rounded p-0.5 text-slate-500 hover:text-rose-300">
                          <Trash2 size={12} />
                        </button>
                      </span>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
                      {b.source.type === 'opcua' ? `${b.source.tags?.length ?? 0} tag(s)` : `${b.source.group}/${b.source.edge}${b.source.device ? `/${b.source.device}` : ''}`}
                      {' → '}
                      {b.target.mode === 'mqtt' ? b.target.pathTemplate : `spBv1.0/${b.target.group}/${b.target.edge}`}
                    </p>
                    <p className="mt-0.5 text-[10px] text-slate-500">
                      {s.published || 0} published · {s.suppressed || 0} deadband
                      {s.errors ? <span className="text-rose-300"> · {s.errors} err</span> : null}
                      {s.lastTs ? ` · ${formatDistanceToNow(s.lastTs, { addSuffix: true })}` : ''}
                    </p>
                    {s.lastError && <p className="truncate text-[10px] text-amber-300">{s.lastError}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        </aside>
      </div>

      {wizardOpen && source && (
        <BindWizard
          source={source}
          selection={selection}
          brokers={brokers}
          onClose={() => setWizardOpen(false)}
          onDone={() => {
            setWizardOpen(false);
            setSelection(new Map());
            loadBindings();
          }}
        />
      )}
      {editingBinding && (
        <BindWizard
          editing={editingBinding}
          source={source}
          selection={selection}
          brokers={brokers}
          onClose={() => setEditingBinding(null)}
          onDone={() => {
            setEditingBinding(null);
            loadBindings();
          }}
        />
      )}
      {csvOpen && source?.type === 'opcua' && (
        <CsvImport
          onClose={() => setCsvOpen(false)}
          onImport={(tags) => {
            setSelection((prev) => {
              const next = new Map(prev);
              for (const t of tags) next.set(t.address, { name: t.name, meta: {} });
              return next;
            });
            setCsvOpen(false);
            setWizardOpen(true);
          }}
        />
      )}
    </div>
  );
}

// ---- lazy tag tree -------------------------------------------------------------

function TagTree({ source, selection, onToggle }) {
  return <TreeLevel source={source} node="" depth={0} selection={selection} onToggle={onToggle} />;
}

function TreeLevel({ source, node, depth, selection, onToggle }) {
  const [children, setChildren] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    api
      .tagBrowse(source.type, source.id, node)
      .then((r) => alive && setChildren(r.children))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [source.type, source.id, node]);

  if (error) return <p className="py-1 pl-4 text-[11px] text-rose-300">{error}</p>;
  if (!children) return <p className="py-1 pl-4 text-[11px] text-slate-500">loading…</p>;
  if (!children.length) return depth === 0 ? <p className="text-xs text-slate-500">Nothing under this source yet.</p> : null;
  return (
    <div className={depth > 0 ? 'border-l border-white/5 pl-3' : ''}>
      {children.map((c) => (
        <TreeNode key={c.id} source={source} node={c} depth={depth} selection={selection} onToggle={onToggle} />
      ))}
    </div>
  );
}

function TreeNode({ source, node, depth, selection, onToggle }) {
  const [open, setOpen] = useState(false);
  const isTag = node.kind === 'tag';
  const selected = isTag && selection.has(node.address);
  return (
    <div>
      <div
        className={clsx(
          'flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs hover:bg-white/5',
          selected && 'bg-accent-500/10'
        )}
        onClick={() => (isTag ? onToggle(node) : setOpen((v) => !v))}
      >
        {isTag ? (
          <>
            <input type="checkbox" readOnly checked={selected} className="pointer-events-none" />
            <CircleDot size={12} className="shrink-0 text-teal-400" />
          </>
        ) : (
          <>
            {open ? <ChevronDown size={13} className="shrink-0 text-slate-500" /> : <ChevronRight size={13} className="shrink-0 text-slate-500" />}
            <FolderClosed size={12} className="shrink-0 text-slate-500" />
          </>
        )}
        <span className={clsx('truncate', isTag ? 'font-mono text-slate-200' : 'text-slate-300')}>{node.name}</span>
        {node.meta?.subtreeCount > 1 && <span className="text-[10px] text-slate-600">{node.meta.subtreeCount}</span>}
      </div>
      {open && !isTag && <TreeLevel source={source} node={node.address} depth={depth + 1} selection={selection} onToggle={onToggle} />}
    </div>
  );
}

// ---- bind wizard ------------------------------------------------------------------

function BindWizard({ source, selection, brokers, editing = null, onClose, onDone }) {
  // Edit mode reuses the wizard: the saved binding seeds every field, the
  // source stays as stored (browse context isn't needed), and save upserts by id.
  const srcType = editing ? editing.source.type : source.type;
  const [name, setName] = useState(editing?.name || '');
  const [mode, setMode] = useState(editing?.target.mode || 'mqtt'); // 'mqtt' | 'sparkplug'
  const [form, setForm] = useState({
    brokerId: editing?.target.brokerId || brokers[0]?.id || '',
    pathTemplate: editing?.target.pathTemplate || 'uns/imported/{name}',
    format: editing?.target.format || 'envelope',
    retain: editing ? editing.target.retain !== false : true,
    qos: editing?.target.qos ?? 0,
    deadband: editing?.target.deadband ?? '',
    samplingInterval: editing?.source.samplingInterval ?? 1000,
    group: editing?.target.group || 'Manifold',
    edge: editing?.target.edge || 'edge1',
    device: editing?.target.device || 'imported'
  });
  const tags = useMemo(() => [...selection.entries()].map(([address, t]) => ({ address, name: t.name })), [selection]);

  const buildTarget = () =>
    mode === 'mqtt'
      ? {
          mode: 'mqtt',
          brokerId: form.brokerId,
          pathTemplate: form.pathTemplate,
          format: form.format,
          retain: form.retain,
          qos: Number(form.qos) || 0,
          ...(Number(form.deadband) > 0 ? { deadband: Number(form.deadband) } : {})
        }
      : { mode: 'sparkplug', brokerId: form.brokerId, group: form.group, edge: form.edge, device: form.device };

  const create = async () => {
    try {
      if (editing) {
        await api.saveBinding({
          id: editing.id,
          name: name || null,
          enabled: editing.enabled !== false,
          source:
            srcType === 'opcua'
              ? { ...editing.source, samplingInterval: Number(form.samplingInterval) || 1000 }
              : editing.source,
          target: buildTarget()
        });
        toast.success('Binding saved');
        onDone();
        return;
      }
      if (source.type === 'mqtt') {
        // MQTT-source tags compile straight into a pipeline route: subscribe
        // to the selection's common prefix, re-path the tail under the UNS base.
        const prefix = commonPrefix(tags.map((t) => t.address));
        const segCount = prefix ? prefix.split('/').filter(Boolean).length : 0;
        const base = form.pathTemplate.replace(/\/?\{name\}$/, '') || 'uns/imported';
        await api.savePipeline({
          name: name || `tags → ${base}`,
          source: { brokerId: source.id, filter: tags.length === 1 ? tags[0].address : `${prefix}#` },
          transforms: [
            { type: 'repath', to: `${base}/{${segCount + 1}-}` },
            ...(form.format === 'envelope' ? [{ type: 'envelope' }] : [])
          ],
          target: { type: 'mqtt', brokerId: form.brokerId, retain: form.retain, qos: Number(form.qos) || 0 }
        });
      } else {
        const body = {
          name: name || null,
          source:
            source.type === 'opcua'
              ? { type: 'opcua', connectionId: source.id, tags, samplingInterval: Number(form.samplingInterval) || 1000 }
              : sparkplugSourceFromSelection(source.id, selection),
          target: buildTarget()
        };
        await api.saveBinding(body);
      }
      toast.success('Binding created');
      onDone();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-black/50 p-6" onClick={onClose}>
      <Card className="w-full max-w-xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-100">
            {editing
              ? `Edit binding ${editing.name || editing.id.slice(0, 8)}`
              : `Add ${srcType === 'sparkplug' ? 'Sparkplug metrics' : `${selection.size} tag(s)`} to the UNS`}
          </h3>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-white/10">
            <X size={14} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Binding name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="line1 motor tags" />
          </Field>
          <Field label="Publish as">
            <select value={mode} onChange={(e) => setMode(e.target.value)} className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200">
              <option value="mqtt">Plain MQTT topics</option>
              {srcType !== 'mqtt' && <option value="sparkplug">Sparkplug B device (NBIRTH/DDATA)</option>}
            </select>
          </Field>
          <Field label="Target broker">
            <select value={form.brokerId} onChange={(e) => setForm({ ...form, brokerId: e.target.value })} className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200">
              {brokers.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </Field>
          {mode === 'mqtt' ? (
            <>
              <Field label="UNS path template">
                <Input value={form.pathTemplate} onChange={(e) => setForm({ ...form, pathTemplate: e.target.value })} placeholder="site/area/line/{name}" />
              </Field>
              <Field label="Format">
                <select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })} className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200">
                  <option value="envelope">TVQ envelope {'{v,t,q}'} (recommended)</option>
                  <option value="plain">Raw value</option>
                </select>
              </Field>
              {srcType === 'opcua' && (
                <Field label="Deadband (abs, optional)">
                  <Input value={form.deadband} onChange={(e) => setForm({ ...form, deadband: e.target.value })} placeholder="0.5" />
                </Field>
              )}
              {srcType === 'opcua' && (
                <Field label="Sampling (ms)">
                  <Input type="number" value={form.samplingInterval} onChange={(e) => setForm({ ...form, samplingInterval: e.target.value })} />
                </Field>
              )}
              <label className="flex items-end gap-2 pb-2 text-xs text-slate-300">
                <input type="checkbox" checked={form.retain} onChange={(e) => setForm({ ...form, retain: e.target.checked })} /> retain
              </label>
            </>
          ) : (
            <>
              <Field label="Group"><Input value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} /></Field>
              <Field label="Edge node"><Input value={form.edge} onChange={(e) => setForm({ ...form, edge: e.target.value })} /></Field>
              <Field label="Device"><Input value={form.device} onChange={(e) => setForm({ ...form, device: e.target.value })} /></Field>
            </>
          )}
        </div>
        <p className="mt-3 text-[11px] leading-snug text-slate-500">
          Bindings are read-only: Manifold monitors the source and republishes — it never writes to a device.
          {mode === 'sparkplug' && ' Sparkplug output uses a dedicated session with proper NBIRTH/NDEATH lifecycle.'}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={create} disabled={!form.brokerId}>{editing ? 'Save changes' : 'Create binding'}</Button>
        </div>
      </Card>
    </div>
  );
}

function sparkplugSourceFromSelection(brokerId, selection) {
  // Selected sparkplug tag ids look like "group/edge[/device]//metric" or
  // "group/edge/device/metric" — reconstruct one (group, edge, device) scope
  // and the metric list from the first selection's path.
  const entries = [...selection.entries()];
  const first = entries[0];
  const meta = first[1].meta || {};
  // The browse API returns metric nodes with address = metric name and
  // meta.device set; the tree id carried the scope, so we ask the user's
  // selection context: all metrics share the source node's scope.
  return {
    type: 'sparkplug',
    brokerId,
    group: meta.group,
    edge: meta.edge,
    device: meta.device || null,
    metrics: entries.map(([address]) => address)
  };
}

function commonPrefix(topics) {
  if (!topics.length) return '';
  let prefix = topics[0].split('/');
  for (const t of topics.slice(1)) {
    const segs = t.split('/');
    let i = 0;
    while (i < prefix.length && prefix[i] === segs[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.length ? prefix.join('/') + '/' : '';
}

// ---- CSV import -------------------------------------------------------------------

function CsvImport({ onClose, onImport }) {
  const [text, setText] = useState('');
  const parse = () => {
    const rows = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const tags = [];
    for (const row of rows) {
      const cols = row.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
      if (!cols[0] || /^(nodeid|address|tag)/i.test(cols[0])) continue; // header
      tags.push({ address: cols[0], name: cols[1] || cols[0].split(/[.;=/]/).pop() });
    }
    if (!tags.length) return toast.error('No rows parsed — expected "nodeId,name" lines');
    onImport(tags);
  };
  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-black/50 p-6" onClick={onClose}>
      <Card className="w-full max-w-xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-100">Import tag list (CSV)</h3>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-white/10">
            <X size={14} />
          </button>
        </div>
        <p className="mb-2 text-[11px] text-slate-500">
          Paste a tag export (Kepware/Ignition-style): one <span className="font-mono">nodeId,name</span> per line. Rows land in the
          selection so you can bind them like browsed tags.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          placeholder={'ns=2;s=Line1.Motor.RPM,Motor RPM\nns=2;s=Line1.Motor.Temp,Motor Temp'}
          className="w-full rounded-lg border border-white/10 bg-surface-950/60 p-2 font-mono text-[11px] text-slate-200 focus:outline-none"
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={parse} disabled={!text.trim()}>Parse & select</Button>
        </div>
      </Card>
    </div>
  );
}
