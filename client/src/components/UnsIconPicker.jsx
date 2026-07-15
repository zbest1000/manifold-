import { useEffect, useMemo, useState } from 'react';
import { X, Search, RotateCcw, Plus, Trash2, Library } from 'lucide-react';
import {
  loadIcons,
  allIconNames,
  curatedIconNames,
  customIconList,
  saveCustomIcon,
  deleteCustomIcon,
  loadFullLibrary,
  fullLibraryLoaded,
  getIconImage,
  setIconOverride,
  getIconOverride,
  resolveIconName
} from '@/graph/unsIcons';

// Mirrors the server-side validation so bad input fails fast with a local message.
const NAME_RE = /^[a-z0-9-]{1,40}$/;
const PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9\s,.+-]+$/;

/**
 * Icon picker for UNS nodes. Three sources:
 *   - Custom: user-defined single-path SVG icons, stored server-side.
 *   - Curated: the bundled ~130-icon industrial subset (default, searchable).
 *   - Full library: the complete Lucide set (~2,000 icons) as an explicit
 *     lazy opt-in — nothing pulls the big chunk until the user asks.
 * Icons preview using the same rasterizer the canvas uses.
 */
export default function UnsIconPicker({ node, onClose, onPicked }) {
  const [query, setQuery] = useState('');
  const [customIcons, setCustomIcons] = useState(customIconList());
  const [fullReady, setFullReady] = useState(fullLibraryLoaded());
  const [loadingFull, setLoadingFull] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadIcons().then(() => setCustomIcons(customIconList()));
  }, []);

  const q = query.trim().toLowerCase();
  const customNames = useMemo(
    () => customIcons.map((i) => i.name).filter((n) => !q || n.includes(q)),
    [customIcons, q]
  );
  const gridNames = useMemo(() => {
    const customSet = new Set(customIcons.map((i) => i.name));
    const source = fullReady ? allIconNames().filter((n) => !customSet.has(n)) : curatedIconNames();
    if (!q) return fullReady ? source.slice(0, 240) : source;
    return source.filter((n) => n.includes(q)).slice(0, 240);
  }, [fullReady, q, customIcons]);

  const current = resolveIconName(node);
  const hasOverride = Boolean(getIconOverride(node.brokerId, node.path));

  const pick = (name) => {
    setIconOverride(node.brokerId, node.path, name);
    onPicked?.(name);
    onClose();
  };

  const submitCustom = async () => {
    const name = newName.trim();
    const svgPath = newPath.trim();
    if (!NAME_RE.test(name)) {
      setFormError('Name must be 1-40 chars: lowercase letters, digits, hyphens.');
      return;
    }
    if (!svgPath || svgPath.length > 4000 || !PATH_RE.test(svgPath)) {
      setFormError('Path must be SVG path data only (M/L/C… commands and numbers), max 4000 chars.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      await saveCustomIcon(name, svgPath);
      setCustomIcons(customIconList());
      setNewName('');
      setNewPath('');
      setShowAdd(false);
    } catch (e) {
      setFormError(e.message || 'Failed to save icon');
    } finally {
      setSaving(false);
    }
  };

  const removeCustom = async (name) => {
    try {
      await deleteCustomIcon(name);
      setCustomIcons(customIconList());
    } catch {
      // API layer already logged it
    }
  };

  const iconCell = (name, extra = null) => {
    const img = getIconImage(name, '#cbd5e1', 40);
    return (
      <div key={name} className="group relative">
        <button
          onClick={() => pick(name)}
          title={name}
          className={`grid aspect-square w-full place-items-center rounded-lg border transition hover:border-accent-500/60 hover:bg-accent-500/10 ${
            name === current ? 'border-accent-500/70 bg-accent-500/15' : 'border-white/5 bg-white/[0.03]'
          }`}
        >
          {img && <img src={img.src} alt={name} className="h-5 w-5" />}
        </button>
        {extra}
      </div>
    );
  };

  const previewPathOk = newPath.trim() && PATH_RE.test(newPath.trim());

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-6" onClick={onClose}>
      <div
        className="flex max-h-[75vh] w-full max-w-lg flex-col rounded-2xl border border-white/10 bg-surface-900 p-4 shadow-2xl"
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
              placeholder={`Search ${allIconNames().length.toLocaleString()} icons…`}
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

        <div className="flex-1 overflow-y-auto pr-1">
          {/* Custom icons */}
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Custom</p>
            <button
              onClick={() => {
                setShowAdd((v) => !v);
                setFormError('');
              }}
              className="flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-slate-300 hover:border-white/25"
            >
              <Plus size={12} /> Add custom icon
            </button>
          </div>

          {showAdd && (
            <div className="mb-3 rounded-xl border border-white/10 bg-surface-950/60 p-3">
              <div className="flex items-start gap-3">
                <div className="flex-1 space-y-2">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="name (e.g. my-reactor)"
                    className="w-full rounded-lg border border-white/10 bg-transparent px-2.5 py-1.5 font-mono text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none"
                  />
                  <textarea
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                    placeholder="SVG path data (d attribute, 24x24 viewBox), e.g. M4 20h16M6 20V8l6-4 6 4v12"
                    rows={3}
                    className="w-full resize-none rounded-lg border border-white/10 bg-transparent px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none"
                  />
                </div>
                <div className="grid h-16 w-16 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.03]" title="Live preview">
                  {previewPathOk ? (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-8 w-8 text-slate-200"
                    >
                      <path d={newPath.trim()} />
                    </svg>
                  ) : (
                    <span className="text-[10px] text-slate-600">preview</span>
                  )}
                </div>
              </div>
              {formError && <p className="mt-2 text-[11px] text-red-400">{formError}</p>}
              <div className="mt-2 flex justify-end gap-2">
                <button
                  onClick={() => setShowAdd(false)}
                  className="rounded-lg px-2.5 py-1 text-[11px] text-slate-400 hover:bg-white/5"
                >
                  Cancel
                </button>
                <button
                  onClick={submitCustom}
                  disabled={saving}
                  className="rounded-lg border border-accent-500/50 bg-accent-500/15 px-2.5 py-1 text-[11px] text-accent-200 hover:bg-accent-500/25 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save icon'}
                </button>
              </div>
            </div>
          )}

          {customNames.length > 0 ? (
            <div className="mb-3 grid grid-cols-8 gap-1.5">
              {customNames.map((name) =>
                iconCell(
                  name,
                  <button
                    aria-label={`Delete custom icon ${name}`}
                    title={`Delete ${name}`}
                    onClick={() => removeCustom(name)}
                    className="absolute -right-1 -top-1 hidden rounded-full border border-white/10 bg-surface-900 p-0.5 text-slate-500 hover:text-red-400 group-hover:block"
                  >
                    <Trash2 size={10} />
                  </button>
                )
              )}
            </div>
          ) : (
            !showAdd && <p className="mb-3 text-[11px] text-slate-600">No custom icons yet.</p>
          )}

          {/* Curated / full library */}
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {fullReady ? 'All icons' : 'Curated'}
          </p>
          <div className="grid grid-cols-8 gap-1.5">{gridNames.map((name) => iconCell(name))}</div>
          {gridNames.length === 0 && customNames.length === 0 && (
            <p className="py-6 text-center text-xs text-slate-500">No icons match “{query}”.</p>
          )}

          {!fullReady && (
            <button
              onClick={() => {
                setLoadingFull(true);
                loadFullLibrary().then(() => {
                  setFullReady(true);
                  setLoadingFull(false);
                });
              }}
              disabled={loadingFull}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-white/15 px-3 py-2 text-xs text-slate-400 hover:border-white/30 hover:text-slate-300 disabled:opacity-50"
            >
              <Library size={13} />
              {loadingFull ? 'Loading full library…' : 'Load full library… (~2,000 more icons)'}
            </button>
          )}
        </div>

        {!query && (
          <p className="mt-2 text-[10px] text-slate-500">
            {fullReady
              ? `Browsing the full set — ${allIconNames().length.toLocaleString()} icons.`
              : 'Showing the curated industrial set — load the full library to browse everything.'}
          </p>
        )}
      </div>
    </div>
  );
}
