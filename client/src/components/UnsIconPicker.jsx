import { useEffect, useMemo, useState } from 'react';
import { X, Search, RotateCcw } from 'lucide-react';
import { loadIcons, allIconNames, getIconImage, setIconOverride, getIconOverride, resolveIconName } from '@/graph/unsIcons';

// Shown before any search: a curated industrial-leaning starter set.
const FEATURED = [
  'factory', 'building-2', 'warehouse', 'network', 'layout-grid', 'rows-3', 'component', 'boxes', 'package', 'container',
  'cog', 'wrench', 'cpu', 'circuit-board', 'server', 'database', 'hard-drive', 'radio', 'antenna', 'router',
  'zap', 'plug-zap', 'battery-charging', 'fuel', 'flame', 'snowflake', 'fan', 'wind', 'cloud', 'waves',
  'droplet', 'droplets', 'thermometer', 'gauge', 'circle-gauge', 'weight', 'timer', 'activity', 'audio-waveform', 'siren',
  'flask-conical', 'beaker', 'test-tube', 'microscope', 'badge-check', 'shield-check', 'triangle-alert', 'clipboard-list', 'chart-line', 'chart-column',
  'truck', 'forklift', 'bot', 'camera', 'scan-line', 'printer', 'lightbulb', 'door-open', 'blocks', 'pipette'
];

/**
 * Icon picker for UNS nodes: search the full Lucide set (~2,000 icons) and pin
 * one to the selected namespace node, or reset to automatic (keyword/level)
 * mapping. Icons preview using the same rasterizer the canvas uses.
 */
export default function UnsIconPicker({ node, onClose, onPicked }) {
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    loadIcons().then(() => setReady(true));
  }, []);

  const names = useMemo(() => {
    if (!ready) return [];
    const q = query.trim().toLowerCase();
    if (!q) return FEATURED.filter((n) => allIconNames().includes(n));
    return allIconNames()
      .filter((n) => n.includes(q))
      .slice(0, 240);
  }, [ready, query]);

  const current = resolveIconName(node);
  const hasOverride = Boolean(getIconOverride(node.brokerId, node.path));

  const pick = (name) => {
    setIconOverride(node.brokerId, node.path, name);
    onPicked?.(name);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-6" onClick={onClose}>
      <div
        className="flex max-h-[70vh] w-full max-w-lg flex-col rounded-2xl border border-white/10 bg-surface-900 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-100">
              Icon for <span className="font-mono text-accent-300">{node.name}</span>
            </p>
            <p className="text-[11px] text-slate-500">
              current: <span className="font-mono">{current}</span>
              {hasOverride ? ' (manual)' : ' (automatic)'}
            </p>
          </div>
          <button aria-label="Close icon picker" onClick={onClose} className="rounded p-1.5 text-slate-400 hover:bg-white/10">
            <X size={16} />
          </button>
        </div>

        <div className="mb-3 flex items-center gap-2">
          <div className="flex flex-1 items-center gap-1.5 rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2">
            <Search size={14} className="text-slate-500" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={ready ? `Search ${allIconNames().length.toLocaleString()} icons…` : 'Loading icon set…'}
              className="w-full bg-transparent text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none"
            />
          </div>
          {hasOverride && (
            <button
              onClick={() => {
                setIconOverride(node.brokerId, node.path, null);
                onPicked?.(null);
                onClose();
              }}
              title="Reset to automatic mapping"
              className="flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 hover:border-white/25"
            >
              <RotateCcw size={13} /> Auto
            </button>
          )}
        </div>

        <div className="grid flex-1 grid-cols-8 gap-1.5 overflow-y-auto pr-1">
          {names.map((name) => {
            const img = getIconImage(name, '#cbd5e1', 40);
            return (
              <button
                key={name}
                onClick={() => pick(name)}
                title={name}
                className={`grid aspect-square place-items-center rounded-lg border transition hover:border-accent-500/60 hover:bg-accent-500/10 ${
                  name === current ? 'border-accent-500/70 bg-accent-500/15' : 'border-white/5 bg-white/[0.03]'
                }`}
              >
                {img && <img src={img.src} alt={name} className="h-5 w-5" />}
              </button>
            );
          })}
          {ready && names.length === 0 && (
            <p className="col-span-8 py-6 text-center text-xs text-slate-500">No icons match “{query}”.</p>
          )}
        </div>
        {!query && ready && (
          <p className="mt-2 text-[10px] text-slate-500">Showing a featured industrial set — search to browse all {allIconNames().length.toLocaleString()} icons.</p>
        )}
      </div>
    </div>
  );
}
