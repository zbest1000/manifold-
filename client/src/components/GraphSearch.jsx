import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Crosshair } from 'lucide-react';
import clsx from 'clsx';
import { topicMatches, isWildcard } from '@/lib/mqtt';

/**
 * Search overlay for a node graph. As the user types it reports the set of
 * matching node ids (for highlight/dim), can zoom-to-fit them, and shows a
 * results dropdown — clicking a result SELECTS that node (opens its details).
 * That's the reliable way to reach a node's properties in a dense graph where
 * clicking a specific dot is near-impossible. The parent owns the graph.
 */
const MAX_RESULTS = 10;

export default function GraphSearch({ nodes, onMatches, onFit, onSelect }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  // Matching node OBJECTS (leaf/branch nodes first, so useful topics rank up).
  const matches = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    const wild = isWildcard(q);
    const lower = q.toLowerCase();
    const out = [];
    for (const n of nodes) {
      const topic = n.meta?.fullTopic;
      if (wild) {
        if (topic && topicMatches(q, topic)) out.push(n);
      } else {
        const hay = `${n.label} ${topic || ''} ${n.meta?.nodeId || ''} ${n.meta?.elementId || ''}`.toLowerCase();
        if (hay.includes(lower)) out.push(n);
      }
    }
    // Rank leaves (have a value/are a real topic) before aggregate branches.
    out.sort((a, b) => (b.meta?.isLeaf ? 1 : 0) - (a.meta?.isLeaf ? 1 : 0) || (b.degree || 0) - (a.degree || 0));
    return out;
  }, [query, nodes]);

  const matchIds = useMemo(() => (matches ? new Set(matches.map((n) => n.id)) : null), [matches]);

  useEffect(() => {
    onMatches(matchIds);
  }, [matchIds, onMatches]);

  // Close the dropdown on outside click.
  useEffect(() => {
    const onDoc = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, []);

  const count = matches ? matches.length : 0;
  const results = matches ? matches.slice(0, MAX_RESULTS) : [];

  const pick = (n) => {
    onSelect?.(n);
    onFit?.(new Set([n.id]));
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="pointer-events-auto absolute left-4 top-4 z-10 w-72">
      <div className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-surface-900/80 px-2.5 py-1.5 backdrop-blur">
        <Search size={15} className="text-slate-500" />
        <input
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results[0]) pick(results[0]);
            else if (e.key === 'Escape') setOpen(false);
          }}
          placeholder="Search nodes… (Enter to open)"
          className="flex-1 bg-transparent text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none"
        />
        {query && (
          <>
            <span className={clsx('text-[11px] tabular-nums', count ? 'text-accent-300' : 'text-slate-500')}>{count}</span>
            <button
              onClick={() => matchIds && matchIds.size && onFit(matchIds)}
              title="Zoom to matches"
              className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200"
            >
              <Crosshair size={14} />
            </button>
            <button onClick={() => setQuery('')} className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200">
              <X size={14} />
            </button>
          </>
        )}
      </div>

      {open && query && (
        <div className="mt-1 max-h-72 overflow-y-auto rounded-xl border border-white/10 bg-surface-900/95 py-1 shadow-2xl backdrop-blur">
          {results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-slate-500">No nodes match “{query}”.</p>
          ) : (
            <>
              {results.map((n) => (
                <button
                  key={n.id}
                  onClick={() => pick(n)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition hover:bg-white/5"
                  title={n.meta?.fullTopic || n.label}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-slate-200">{n.label}</span>
                    {n.meta?.fullTopic && n.meta.fullTopic !== n.label && (
                      <span className="mono block truncate text-2xs text-slate-500">{n.meta.fullTopic}</span>
                    )}
                  </span>
                  <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-slate-500">
                    {n.group}
                  </span>
                </button>
              ))}
              {count > results.length && <p className="px-3 py-1 text-2xs text-slate-500">Showing {results.length} of {count}. Refine the query.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
