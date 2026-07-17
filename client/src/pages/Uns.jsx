import { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import {
  Network, Radio, Cpu, Boxes, X, Activity, ListTree, Share2, Search, Pencil,
  ShieldCheck, History, Layers, Plug, Trash2, Plus
} from 'lucide-react';
import { useStore, onMessageActivity } from '@/store/store';
import { api } from '@/lib/api';
import UnsTopology, {
  buildUnsTree, levelName, levelColor, lastActive, nodeValue, nodeRate, staleness, expectedInterval, DEFAULT_LEVELS
} from '@/graph/UnsTopology';
import { buildMountRoots } from '@/graph/unsMounts';
import { resolveIconName, getIconImage } from '@/graph/unsIcons';
import PageHeader from '@/components/PageHeader';
import GraphTree from '@/components/GraphTree';
import ViewTab from '@/components/ViewTab';
import { Button, EmptyState, HelpButton } from '@/components/ui';
import { formatDistanceToNow } from 'date-fns';

// Icon picker pulls the full Lucide set — its own chunk, loaded on demand.
const UnsIconPicker = lazy(() => import('@/components/UnsIconPicker'));

const LEVELS_KEY = 'tc.unsLevels';
function loadLevels() {
  try {
    const raw = localStorage.getItem(LEVELS_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) && arr.length >= 2 ? arr.map(String) : [...DEFAULT_LEVELS];
  } catch {
    return [...DEFAULT_LEVELS];
  }
}

/**
 * UNS — the Unified Namespace topology. One live map of the whole namespace,
 * organized by ISA-95-style levels rather than raw topics, with data sources
 * (MQTT brokers, OPC UA, i3X) surfaced as header chips and branches lighting up
 * while data flows through them. This is the "whole plant at a glance" lens the
 * tool grows into beyond per-protocol exploration.
 */
export default function Uns() {
  const brokers = useStore((s) => s.brokers);
  const opcua = useStore((s) => s.opcua);
  const topicVersionMap = useStore((s) => s.topicVersion);
  const [scope, setScope] = useState('all'); // 'all' | brokerId
  const [view, setView] = useState('topology'); // 'topology' | 'tree'
  const [treeFilter, setTreeFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [focusTarget, setFocusTarget] = useState(null); // { brokerId, path } to pan the map onto
  const [pickerOpen, setPickerOpen] = useState(false);
  const [iconTick, setIconTick] = useState(0); // bump after a pick so previews refresh
  const [i3xStatus, setI3xStatus] = useState(null);
  const [rate, setRate] = useState(0);
  const rateCount = useRef(0);
  // Side panel (docked, right): 'lint' | 'events' | null. The node detail
  // column shows when no panel is open.
  const [panel, setPanel] = useState(null);
  // Editable level ladder (persisted).
  const [levels, setLevels] = useState(loadLevels);
  const [levelsOpen, setLevelsOpen] = useState(false);
  // Mounts: external sources grafted into the forest.
  const [mounts, setMounts] = useState([]);
  const [mountRoots, setMountRoots] = useState([]);
  const [mountsOpen, setMountsOpen] = useState(false);

  const connected = brokers.filter((b) => b.status === 'connected');
  const setTopics = useStore((s) => s.setTopics);

  // Seed the topic index from the authoritative REST list — the live socket
  // stream only carries topics that publish while the page is open.
  useEffect(() => {
    for (const b of connected) {
      api
        .brokerTopics(b.id)
        .then((res) => setTopics(b.id, res.topics))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected.map((b) => b.id).join('|')]);

  // Message rate chip: count bus events, publish once a second.
  useEffect(() => {
    const off = onMessageActivity(() => {
      rateCount.current++;
    });
    const t = setInterval(() => {
      setRate(rateCount.current);
      rateCount.current = 0;
    }, 1000);
    return () => {
      off?.();
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    api.i3xStatus().then(setI3xStatus).catch(() => {});
  }, []);

  // Mounts: load config, then resolve each into a namespace root.
  const [mountTick, setMountTick] = useState(0);
  useEffect(() => {
    let alive = true;
    api
      .listMounts()
      .then(async ({ mounts: list }) => {
        if (!alive) return;
        setMounts(list);
        const roots = await buildMountRoots(list, { opcuaConnections: opcua });
        if (alive) setMountRoots(roots);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountTick, opcua.map((c) => c.id).join('|')]);

  // Mounted structure is a snapshot — refresh it periodically while mounts
  // exist (and on demand from the Mounts panel) so grafted trees don't rot.
  useEffect(() => {
    if (!mounts.length) return undefined;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') setMountTick((v) => v + 1);
    }, 60_000);
    return () => clearInterval(t);
  }, [mounts.length]);

  const scoped = scope === 'all' ? connected : connected.filter((b) => b.id === scope);
  // Rebuild namespace trees only when the topic SET changes on a scoped broker.
  const versionKey = scoped.map((b) => `${b.id}:${topicVersionMap[b.id] || 0}`).join('|');
  const brokerRoots = useMemo(
    () => scoped.map((b) => buildUnsTree(b, useStore.getState().getTopics(b.id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [versionKey]
  );
  // Mounted sources appear in the "all" scope alongside broker namespaces.
  const roots = useMemo(
    () => (scope === 'all' ? [...brokerRoots, ...mountRoots] : brokerRoots),
    [brokerRoots, mountRoots, scope]
  );

  // Flat {nodes, links} projection of the same forest for the Tree view, plus an
  // id -> UNS-node index so tree selection drives the same detail panel.
  const flat = useMemo(() => {
    const nodes = [];
    const links = [];
    const byId = new Map();
    const walk = (n, parentId) => {
      nodes.push({ id: n.id, label: n.name, group: 'topic', kind: 'uns', meta: { level: levelName(n.depth, levels) } });
      byId.set(n.id, n);
      if (parentId) links.push({ source: parentId, target: n.id });
      for (const c of n.children.values()) walk(c, n.id);
    };
    for (const r of roots) walk(r, null);
    return { nodes, links, byId };
  }, [roots, levels]);

  const saveLevels = (next) => {
    setLevels(next);
    try {
      localStorage.setItem(LEVELS_KEY, JSON.stringify(next));
    } catch {
      // persistence is best-effort
    }
  };

  // Jump from a lint finding / event to the node in the namespace: select it
  // (highlights it + drives the detail panel) AND pan the topology canvas onto
  // it, expanding ancestors so it is actually on-screen. A fresh object each
  // call so clicking the same finding twice re-focuses.
  const jumpTo = (brokerId, path) => {
    const node = flat.byId.get(`uns:${brokerId}:${path}`);
    if (node) setSelected(node);
    setView('topology'); // the pan-to-node only makes sense on the map
    setFocusTarget({ brokerId, path });
  };

  if (!connected.length && !mountRoots.length) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Unified Namespace" subtitle="Live topology of the whole namespace, by ISA-95 level" />
        <EmptyState
          icon={Network}
          title="No connected brokers"
          hint="The UNS view maps every connected data source into one live namespace topology. Connect an MQTT broker to begin."
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
        title="Unified Namespace"
        subtitle="live topology"
        actions={
          <div className="flex items-center gap-2">
            <HelpButton title="How the Unified Namespace view works" label="How this view works">
              <p>
                This view maps every connected source into one live namespace, laid out as an ISA-95 hierarchy: Enterprise,
                Site, Area, Line, Cell, and so on down to individual tags. Each broker becomes a tree, and mounted sources
                (OPC UA, i3X) sit beside them.
              </p>
              <p>Two ways to look at it:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li><b>Topology</b>: the graph. Nodes are badges, edges show the parent-child path.</li>
                <li><b>Tree</b>: the same namespace as a searchable, collapsible list.</li>
              </ul>
              <p>Reading the topology:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>An edge turns <b className="text-emerald-400">green and animated</b> while data is flowing through that branch, and fades to gray when it goes quiet.</li>
                <li>A leaf carries a status dot: <b className="text-emerald-400">green</b> is publishing now, <b className="text-amber-400">amber</b> is overdue (silent about 3x its usual interval), <b className="text-rose-400">red</b> is dead (about 10x).</li>
                <li>A leaf&apos;s latest value is printed under its name, so the map doubles as a live dashboard.</li>
              </ul>
              <p>Getting around:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>Click a node to open its detail. Double-click, or click the <b>+ / -</b> badge, to expand or collapse.</li>
                <li>Drag a node to move it; it stays where you drop it. Ctrl or Cmd-click several nodes, or shift-drag a box, to move a group together. <b>Auto arrange</b> resets the layout, <b>Fit</b> re-frames it.</li>
              </ul>
              <p className="text-slate-400">
                The buttons up top: <b>Lint</b> checks the namespace for structural problems and jumps you to each one.
                <b> Events</b> is a live feed of new topics and Sparkplug births and deaths. <b>Levels</b> renames the ISA-95
                tiers. <b>Mounts</b> grafts in OPC UA and i3X sources.
              </p>
            </HelpButton>
            <div className="flex overflow-hidden rounded-xl border border-white/10">
              <ViewTab active={view === 'topology'} onClick={() => setView('topology')} icon={Share2} label="Topology" />
              <ViewTab active={view === 'tree'} onClick={() => setView('tree')} icon={ListTree} label="Tree" />
            </div>
            <HeaderButton
              icon={ShieldCheck}
              label="Lint"
              active={panel === 'lint'}
              onClick={() => setPanel((p) => (p === 'lint' ? null : 'lint'))}
            />
            <HeaderButton
              icon={History}
              label="Events"
              active={panel === 'events'}
              onClick={() => setPanel((p) => (p === 'events' ? null : 'events'))}
            />
            <HeaderButton icon={Layers} label="Levels" active={levelsOpen} onClick={() => setLevelsOpen((v) => !v)} />
            <HeaderButton icon={Plug} label="Sources" active={mountsOpen} onClick={() => setMountsOpen((v) => !v)} />
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-200 focus:border-accent-500/60 focus:outline-none"
            >
              <option value="all">All namespaces</option>
              {connected.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        }
      />

      <div className="relative min-h-0 flex-1">
        {/* Source + rate chips, in the reference style (topology surface only) */}
        {view === 'topology' && (
        <div className="pointer-events-none absolute left-4 top-4 z-10 flex flex-wrap items-center gap-2">
          <Chip tone="live">
            <Activity size={12} /> live · {rate.toLocaleString()}/s
          </Chip>
          {scoped.map((b) => (
            <Chip key={b.id} tone="mqtt">
              <Radio size={12} /> {b.name} <Dot on />
            </Chip>
          ))}
          {opcua.filter((c) => c.status === 'connected').map((c) => (
            <Chip key={c.id} tone="opcua">
              <Cpu size={12} /> OPC-UA <Dot on />
            </Chip>
          ))}
          {i3xStatus?.configured && (
            <Chip tone="opcua">
              <Boxes size={12} /> i3X <Dot on={Boolean(i3xStatus.info)} />
            </Chip>
          )}
        </div>
        )}

        {levelsOpen && <LevelsEditor levels={levels} onSave={saveLevels} onClose={() => setLevelsOpen(false)} />}
        {mountsOpen && (
          <MountManager
            mounts={mounts}
            brokers={connected}
            opcua={opcua}
            i3xStatus={i3xStatus}
            onChanged={() => setMountTick((v) => v + 1)}
            onClose={() => setMountsOpen(false)}
          />
        )}

        <div className="flex h-full w-full">
          {view === 'tree' ? (
            <div className="flex w-full max-w-md flex-col border-r border-white/5 bg-surface-900/30">
              <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2">
                <Search size={14} className="text-slate-500" />
                <input
                  value={treeFilter}
                  onChange={(e) => setTreeFilter(e.target.value)}
                  placeholder="Filter namespace…"
                  className="w-full bg-transparent text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none"
                />
              </div>
              <GraphTree
                nodes={flat.nodes}
                links={flat.links}
                selectedId={selected?.id || null}
                onSelect={(n) => setSelected(flat.byId.get(n.id) || null)}
                filter={treeFilter}
              />
            </div>
          ) : (
          <div className="relative min-w-0 flex-1">
            <UnsTopology roots={roots} levels={levels} selectedId={selected?.id || null} onSelect={setSelected} focusTarget={focusTarget} />
          </div>
          )}

          {/* Docked right column: lint / events panel when open, else node detail.
              Never overlays the canvas, so it can't block nodes or the second
              click of a double-click. */}
          {panel === 'lint' && <LintPanel brokers={scoped} onJump={jumpTo} onClose={() => setPanel(null)} />}
          {panel === 'events' && <EventsPanel brokers={scoped} onJump={jumpTo} onClose={() => setPanel(null)} />}
          {!panel && selected && (
            <aside className="w-72 shrink-0 overflow-y-auto border-l border-white/5 bg-surface-900/40 p-3">
              <div className="mb-1 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-100">{selected.name}</div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: levelColor(selected.depth) }}>
                    {levelName(selected.depth, levels)}
                  </div>
                </div>
                <button aria-label="Close details" onClick={() => setSelected(null)} className="rounded p-1 text-slate-400 hover:bg-white/10">
                  <X size={14} />
                </button>
              </div>
              <div className="space-y-1 text-xs text-slate-400">
                {selected.path && (
                  <div className="truncate font-mono text-[11px] text-slate-300" title={selected.path}>
                    {selected.path}
                  </div>
                )}
                <Row k="Topics in branch" v={selected.topicCount.toLocaleString()} />
                <Row k="Direct children" v={selected.children.size.toLocaleString()} />
                <LiveRows node={selected} />
                <IconRow key={iconTick} node={selected} onChange={() => setPickerOpen(true)} />
              </div>
            </aside>
          )}
        </div>

        {pickerOpen && selected && (
          <Suspense fallback={null}>
            <UnsIconPicker node={selected} onClose={() => setPickerOpen(false)} onPicked={() => setIconTick((v) => v + 1)} />
          </Suspense>
        )}

        {/* Legend, matching the visual language (topology surface only) */}
        {view === 'topology' && (
        <div className="pointer-events-none absolute bottom-4 left-4 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-slate-300/60 bg-white/85 px-3 py-2 text-[11px] text-slate-600 shadow-sm backdrop-blur">
          {levels.slice(0, 4).map((lvl, i) => (
            <span key={lvl} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full border-2 bg-white" style={{ borderColor: levelColor(i) }} />
              {lvl}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="#22c55e" strokeWidth="1.6" strokeDasharray="6 4" /></svg>
            publishing
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" /> overdue
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-red-500" /> dead
          </span>
          <span className="text-slate-400">double-click / ± to expand</span>
        </div>
        )}

      </div>
    </div>
  );
}

function HeaderButton({ icon: Icon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm transition ${
        active
          ? 'border-accent-500/40 bg-accent-500/15 text-accent-300'
          : 'border-white/10 bg-surface-950/60 text-slate-300 hover:bg-white/5'
      }`}
    >
      <Icon size={15} /> {label}
    </button>
  );
}

// ---- Level ladder editor -----------------------------------------------------

function LevelsEditor({ levels, onSave, onClose }) {
  const [draft, setDraft] = useState(levels);
  const set = (i, v) => setDraft((d) => d.map((x, j) => (j === i ? v : x)));
  return (
    <div className="absolute right-4 top-4 z-20 w-72 rounded-xl border border-white/10 bg-surface-900/95 p-3 shadow-xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-100">Level ladder</span>
        <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-white/10">
          <X size={14} />
        </button>
      </div>
      <p className="mb-2 text-[11px] text-slate-500">
        Names for each hierarchy depth (ISA-95 by default). The last name repeats for deeper levels.
      </p>
      <div className="space-y-1.5">
        {draft.map((lvl, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-4 text-right font-mono text-[10px] text-slate-500">{i}</span>
            <input
              value={lvl}
              onChange={(e) => set(i, e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-surface-950/60 px-2 py-1 text-xs text-slate-200 focus:border-accent-500/60 focus:outline-none"
            />
            {draft.length > 2 && (
              <button
                aria-label="Remove level"
                onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                className="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-red-400"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <button
          onClick={() => setDraft((d) => [...d, `Level ${d.length}`])}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-accent-300 hover:bg-white/10"
        >
          <Plus size={12} /> add level
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => setDraft([...DEFAULT_LEVELS])}
            className="rounded px-2 py-1 text-[11px] text-slate-400 hover:bg-white/10"
          >
            Reset
          </button>
          <button
            onClick={() => {
              const clean = draft.map((s) => s.trim()).filter(Boolean);
              if (clean.length >= 2) {
                onSave(clean);
                onClose();
              }
            }}
            className="rounded-lg bg-accent-500/20 px-2.5 py-1 text-[11px] font-medium text-accent-200 hover:bg-accent-500/30"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Mount manager -------------------------------------------------------------

function MountManager({ mounts, brokers = [], opcua, i3xStatus, onChanged, onClose }) {
  const [type, setType] = useState('opcua');
  const [connectionId, setConnectionId] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const connectedOpcua = opcua.filter((c) => c.status === 'connected');

  const add = async () => {
    setBusy(true);
    try {
      await api.addMount({ type, connectionId: type === 'opcua' ? connectionId || connectedOpcua[0]?.id : null, label: label || null });
      setLabel('');
      onChanged();
    } catch {
      // pushLog already captured it
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    try {
      await api.removeMount(id);
      onChanged();
    } catch {
      // pushLog already captured it
    }
  };

  return (
    <div className="absolute right-4 top-4 z-20 w-80 rounded-xl border border-white/10 bg-surface-900/95 p-3 shadow-xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-100">UNS sources</span>
        <span className="flex items-center gap-1">
          <HelpButton title="What feeds the Unified Namespace?" label="About UNS sources">
            <p>
              The namespace is one shared tree that several sources feed at once. They fall into two groups.
            </p>
            <p><b>Live sources</b> stream real values into the namespace:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <b>MQTT</b>: every connected broker&apos;s topic tree shows up as a live branch. This is the backbone of the
                namespace, so brokers are always here. You add and remove them on the <b>MQTT Brokers</b> page.
              </li>
              <li>
                <b>Sparkplug</b>: when a broker carries Sparkplug B traffic, Manifold decodes it automatically and shows the
                Group, Edge Node, Device, and metric structure inside that broker&apos;s branch. It is not a separate
                connection.
              </li>
            </ul>
            <p><b>Mounted sources</b> graft in <b>structure only</b>. They map out what exists but do not stream values:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <b>OPC UA</b>: a server&apos;s address space, browsed like an OPC UA client would show it, for example
                <code>Objects/DeviceSet/Robot1</code>.
              </li>
              <li>
                <b>i3X</b>: the connected i3X object graph, as one branch.
              </li>
            </ul>
            <p>
              <b>How they connect.</b> Every source lands in the same ISA-95 hierarchy, side by side, so you see the whole
              plant in one place. To carry a value from one source into another, build a <b>Pipeline</b> route or a <b>Tag</b>
              binding. For example, mount an OPC UA server to find the node you want, then route it into
              <code>uns/plant1/line1</code> on your broker so it becomes a live topic that others can subscribe to.
            </p>
            <p className="text-slate-400">
              Mounted sources re-browse every 60 seconds. Press <b>Refresh</b> to update now.
            </p>
          </HelpButton>
          <button
            onClick={onChanged}
            title="Re-browse mounted sources now (also refreshes every 60s)"
            className="rounded px-1.5 py-0.5 text-[11px] text-accent-300 hover:bg-white/10"
          >
            Refresh
          </button>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-white/10">
            <X size={14} />
          </button>
        </span>
      </div>
      <p className="mb-2 text-[11px] leading-snug text-slate-500">
        Everything below feeds one namespace. MQTT brokers (and any Sparkplug traffic on them) stream live; OPC UA and
        i3X graft in structure only. To carry values across sources, use a Pipeline route or a Tag binding.
      </p>

      {/* Live sources: MQTT brokers (Sparkplug is decoded within them) — managed on the Brokers page */}
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Live sources</p>
      <div className="mb-3 space-y-1">
        {brokers.length === 0 ? (
          <p className="text-[11px] text-slate-500">
            No brokers connected. Add one on the <b className="text-slate-400">MQTT Brokers</b> page.
          </p>
        ) : (
          brokers.map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded-lg bg-black/20 px-2 py-1.5 text-xs">
              <span className="truncate text-slate-300">
                <span className="mr-1.5 rounded bg-emerald-500/15 px-1 py-0.5 font-mono text-[10px] uppercase text-emerald-300">mqtt</span>
                {b.name || `${b.host}:${b.port}`}
              </span>
              <span className="text-[10px] text-emerald-400">live</span>
            </div>
          ))
        )}
      </div>

      {/* Mounted sources: OPC UA / i3X, structure only */}
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Mounted sources</p>
      {mounts.length > 0 && (
        <div className="mb-2 space-y-1">
          {mounts.map((m) => (
            <div key={m.id} className="flex items-center justify-between rounded-lg bg-black/20 px-2 py-1.5 text-xs">
              <span className="truncate text-slate-300">
                <span className="mr-1.5 rounded bg-white/10 px-1 py-0.5 font-mono text-[10px] uppercase">{m.type}</span>
                {m.label || m.connectionId || 'i3X namespace'}
              </span>
              <button aria-label="Remove mount" onClick={() => remove(m.id)} className="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-red-400">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="space-y-1.5">
        <div className="flex gap-1.5">
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="rounded-lg border border-white/10 bg-surface-950/60 px-2 py-1 text-xs text-slate-200 focus:outline-none"
          >
            <option value="opcua">OPC UA</option>
            <option value="i3x">i3X</option>
          </select>
          {type === 'opcua' && (
            <select
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-surface-950/60 px-2 py-1 text-xs text-slate-200 focus:outline-none"
            >
              {connectedOpcua.length === 0 && <option value="">no connections</option>}
              {connectedOpcua.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.endpointUrl}
                </option>
              ))}
            </select>
          )}
        </div>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          className="w-full rounded-lg border border-white/10 bg-surface-950/60 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:border-accent-500/60 focus:outline-none"
        />
        <button
          onClick={add}
          disabled={busy || (type === 'opcua' && connectedOpcua.length === 0) || (type === 'i3x' && !i3xStatus?.configured)}
          className="w-full rounded-lg bg-accent-500/20 px-2.5 py-1.5 text-[11px] font-medium text-accent-200 hover:bg-accent-500/30 disabled:opacity-40"
        >
          Mount source
        </button>
      </div>
    </div>
  );
}

// ---- Lint panel ------------------------------------------------------------------

const SEV_COLOR = { error: 'text-red-400', warn: 'text-amber-400', info: 'text-sky-400' };

function LintPanel({ brokers, onJump, onClose }) {
  const [reports, setReports] = useState(null); // [{ broker, report }]
  useEffect(() => {
    let alive = true;
    Promise.all(
      brokers.map((b) =>
        api
          .unsLint(b.id)
          .then((report) => ({ broker: b, report }))
          .catch(() => ({ broker: b, report: null }))
      )
    ).then((r) => alive && setReports(r));
    return () => {
      alive = false;
    };
  }, [brokers]);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-white/5 bg-surface-900/40">
      <PanelHeader icon={ShieldCheck} title="Namespace lint" onClose={onClose} />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {!reports && <p className="text-xs text-slate-500">Analyzing namespace…</p>}
        {reports?.map(({ broker, report }) => (
          <div key={broker.id}>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="truncate text-xs font-semibold text-slate-200">{broker.name}</span>
              {report && <ScoreBadge score={report.score} />}
            </div>
            {!report && <p className="text-[11px] text-slate-500">lint unavailable</p>}
            {report && report.findings.length === 0 && (
              <p className="text-[11px] text-emerald-400">No structural issues found in {report.stats.topics.toLocaleString()} topics.</p>
            )}
            {report?.findings.map((f, i) => {
              const navigable = Boolean(f.path);
              const cls = `mb-1 block w-full rounded-lg bg-black/20 px-2 py-1.5 text-left text-[11px] ${navigable ? 'group cursor-pointer transition hover:bg-white/5' : ''}`;
              const body = (
                <>
                  <div className="flex items-start gap-1.5">
                    <span className={`font-semibold ${SEV_COLOR[f.severity] || 'text-slate-300'}`}>{f.title}</span>
                    {navigable && (
                      <span className="ml-auto shrink-0 text-[10px] text-accent-300 opacity-0 transition group-hover:opacity-100">jump →</span>
                    )}
                  </div>
                  {f.path && <div className="mt-0.5 break-all font-mono text-[10px] text-slate-400">{f.path}</div>}
                  {f.detail && <div className="mt-0.5 text-slate-400">{f.detail}</div>}
                  {/* WHY it matters — the finding's explanation, previously dropped. */}
                  {f.why && <div className="mt-1 leading-snug text-[10px] text-slate-500">{f.why}</div>}
                </>
              );
              return navigable ? (
                <button key={i} type="button" onClick={() => onJump(broker.id, f.path)} className={cls} title="Jump to this node in the topology">
                  {body}
                </button>
              ) : (
                <div key={i} className={cls}>
                  {body}
                </div>
              );
            })}
            {report?.truncated && (
              <p className="text-[10px] text-slate-500">
                Findings truncated — totals: {Object.entries(report.stats.byRule).map(([r, c]) => `${r}: ${c}`).join(', ')}
              </p>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}

function ScoreBadge({ score }) {
  const color = score >= 85 ? 'text-emerald-400 border-emerald-500/40' : score >= 60 ? 'text-amber-400 border-amber-500/40' : 'text-red-400 border-red-500/40';
  return <span className={`rounded-lg border px-1.5 py-0.5 font-mono text-[11px] ${color}`}>{score}/100</span>;
}

// ---- Events panel -------------------------------------------------------------------

const EVENT_LABEL = {
  'topic-added': 'new topic',
  'edge-birth': 'edge online',
  'edge-death': 'edge offline',
  'device-birth': 'device online',
  'device-death': 'device offline'
};
const EVENT_COLOR = {
  'topic-added': 'text-sky-400',
  'edge-birth': 'text-emerald-400',
  'device-birth': 'text-emerald-400',
  'edge-death': 'text-red-400',
  'device-death': 'text-red-400'
};

function EventsPanel({ brokers, onJump, onClose }) {
  const [events, setEvents] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all(
        brokers.map((b) =>
          api
            .unsEvents(b.id)
            .then((r) => r.events.map((e) => ({ ...e, brokerId: b.id, brokerName: b.name })))
            .catch(() => [])
        )
      ).then((all) => {
        if (!alive) return;
        setEvents(all.flat().sort((a, b) => b.ts - a.ts).slice(0, 300));
      });
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [brokers]);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-white/5 bg-surface-900/40">
      <PanelHeader icon={History} title="Namespace events" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!events && <p className="text-xs text-slate-500">Loading…</p>}
        {events?.length === 0 && <p className="text-xs text-slate-500">No events yet — new topics and Sparkplug BIRTH/DEATH show up here.</p>}
        {events?.map((e, i) => (
          <button
            key={i}
            onClick={() => e.topic && onJump(e.brokerId, e.topic.split('/').filter(Boolean).join('/'))}
            className="mb-1 block w-full rounded-lg bg-black/20 px-2 py-1.5 text-left text-[11px] hover:bg-white/5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className={`font-semibold ${EVENT_COLOR[e.type] || 'text-slate-300'}`}>
                {EVENT_LABEL[e.type] || e.type}
                {e.cascaded ? ' (cascade)' : ''}
              </span>
              <span className="shrink-0 text-[10px] text-slate-500">{formatDistanceToNow(e.ts, { addSuffix: true })}</span>
            </div>
            <div className="mt-0.5 break-all font-mono text-[10px] text-slate-400">
              {e.topic || [e.group, e.edgeNode, e.device].filter(Boolean).join(' / ')}
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

function PanelHeader({ icon: Icon, title, onClose }) {
  return (
    <div className="flex items-center justify-between border-b border-white/5 px-3 py-2.5">
      <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-100">
        <Icon size={14} className="text-accent-300" /> {title}
      </span>
      <button aria-label={`Close ${title}`} onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-white/10">
        <X size={14} />
      </button>
    </div>
  );
}

// ---- Detail-panel rows ------------------------------------------------------------

function IconRow({ node, onChange }) {
  const name = resolveIconName(node);
  const img = getIconImage(name, '#cbd5e1', 40);
  return (
    <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-black/20 px-2 py-1.5">
      <span className="flex items-center gap-2 text-slate-400">
        {img && <img src={img.src} alt="" className="h-4 w-4" />}
        <span className="font-mono text-[11px]">{name}</span>
      </span>
      <button onClick={onChange} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-accent-300 hover:bg-white/10">
        <Pencil size={11} /> change
      </button>
    </div>
  );
}

const STALE_LABEL = { fresh: 'fresh', overdue: 'overdue', dead: 'dead' };
const STALE_CLASS = { fresh: 'text-emerald-400', overdue: 'text-amber-400', dead: 'text-red-400' };

function LiveRows({ node }) {
  // Re-read liveness once a second while the panel is open.
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const ts = lastActive(node);
  const val = nodeValue(node);
  const rate = nodeRate(node);
  const stale = node.children.size === 0 ? staleness(node) : null;
  const interval = expectedInterval(node);
  return (
    <>
      <Row k="Last activity" v={ts ? formatDistanceToNow(ts, { addSuffix: true }) : '—'} />
      {rate > 0 && <Row k="Rate" v={`${rate.toLocaleString()} msg/s`} />}
      {val && (
        <div className="rounded-lg bg-black/20 px-2 py-1.5">
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-slate-500">Latest value</div>
          <div className="break-all font-mono text-[11px] text-teal-300">{val.value.slice(0, 300)}</div>
        </div>
      )}
      {stale && (
        <Row
          k="Staleness"
          v={
            <span className={STALE_CLASS[stale]}>
              {STALE_LABEL[stale]}
              {interval > 0 ? ` (~every ${Math.round(interval / 1000) || 1}s)` : ''}
            </span>
          }
        />
      )}
    </>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-500">{k}</span>
      <span className="font-medium text-slate-200">{v}</span>
    </div>
  );
}

function Chip({ children, tone }) {
  const tones = {
    live: 'border-emerald-300 bg-emerald-50 text-emerald-700',
    mqtt: 'border-emerald-300 bg-white text-emerald-700',
    opcua: 'border-sky-300 bg-white text-sky-700'
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium shadow-sm ${tones[tone] || tones.mqtt}`}>
      {children}
    </span>
  );
}

function Dot({ on }) {
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${on ? 'bg-emerald-500' : 'bg-slate-300'}`} />;
}
