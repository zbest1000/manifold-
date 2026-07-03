import { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { groupColor } from '@/graph/buildGraph';
import { GRAPH_STYLES } from '@/graph/graphStyles';

const ROW_H = 26;
const OVERSCAN = 8;

/**
 * Generic collapsible tree for any parent→child graph ({nodes, links}). Used by
 * the OPC UA and i3X views to offer the same tree/graph duality as MQTT. For
 * lazily-loaded sources (OPC UA), expanding a branch calls `onExpandNode` so the
 * page can browse deeper. Virtualized for large address spaces.
 */
export default function GraphTree({ nodes, links, selectedId, onSelect, onExpandNode, valueMap, filter = '' }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);

  const { childrenOf, roots, byId } = useMemo(() => {
    const childrenOf = new Map();
    const incoming = new Set();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const l of links) {
      if (!childrenOf.has(l.source)) childrenOf.set(l.source, []);
      childrenOf.get(l.source).push(l.target);
      incoming.add(l.target);
    }
    const roots = nodes.filter((n) => !incoming.has(n.id));
    return { childrenOf, roots, byId };
  }, [nodes, links]);

  const matchIds = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return null;
    const keep = new Set();
    // Keep matches and all their ancestors
    const parentOf = new Map();
    for (const l of links) parentOf.set(l.target, l.source);
    for (const n of nodes) {
      if (!n.label.toLowerCase().includes(q)) continue;
      let cur = n.id;
      const guard = new Set();
      while (cur && !guard.has(cur)) {
        keep.add(cur);
        guard.add(cur);
        cur = parentOf.get(cur);
      }
    }
    return keep;
  }, [filter, nodes, links]);

  const expandedKey = [...expanded].sort().join('|');
  const rows = useMemo(() => {
    const out = [];
    const forced = Boolean(matchIds);
    const walk = (id, depth, seen) => {
      const n = byId.get(id);
      if (!n || seen.has(id)) return;
      seen.add(id);
      let kids = childrenOf.get(id) || [];
      if (matchIds) kids = kids.filter((k) => matchIds.has(k));
      const hasChildren = kids.length > 0;
      const open = forced || expanded.has(id);
      out.push({ n, depth, hasChildren, open });
      if (hasChildren && open) {
        const sorted = kids.slice().sort((a, b) => (byId.get(a)?.label || '').localeCompare(byId.get(b)?.label || ''));
        for (const k of sorted) walk(k, depth + 1, seen);
      }
    };
    const seen = new Set();
    let rootList = roots;
    if (matchIds) rootList = roots.filter((r) => matchIds.has(r.id));
    for (const r of rootList.slice().sort((a, b) => a.label.localeCompare(b.label))) walk(r.id, 0, seen);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byId, childrenOf, roots, expandedKey, matchIds]);

  const toggle = (n) => {
    if (onExpandNode && !expanded.has(n.id) && !(childrenOf.get(n.id) || []).length) onExpandNode(n);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(n.id)) next.delete(n.id);
      else next.add(n.id);
      return next;
    });
  };

  const style = GRAPH_STYLES.constellation;
  const total = rows.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const slice = rows.slice(start, end);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-white/5 px-3 py-2 text-[11px] text-slate-500">{total.toLocaleString()} rows</div>
      <div
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          setViewH(e.currentTarget.clientHeight);
        }}
        className="relative flex-1 overflow-auto"
      >
        {total === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-slate-500">Nothing to show.</p>
        ) : (
          <div style={{ height: total * ROW_H, position: 'relative' }}>
            {slice.map((row, i) => {
              const { n, depth, hasChildren, open } = row;
              const expandable = hasChildren || (onExpandNode && n.meta?.nodeClass === 'Object');
              const value = valueMap?.[n.id];
              return (
                <div
                  key={n.id}
                  onClick={() => onSelect(n)}
                  className={clsx(
                    'absolute left-0 right-0 flex cursor-pointer items-center gap-1.5 pr-2 text-sm hover:bg-white/5',
                    n.id === selectedId && 'bg-accent-500/15'
                  )}
                  style={{ top: (start + i) * ROW_H, height: ROW_H, paddingLeft: `${depth * 14 + 8}px` }}
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (expandable) toggle(n);
                    }}
                    className={clsx('shrink-0 text-slate-500', !expandable && 'invisible')}
                  >
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: groupColor(n.group, style.palette) }}
                  />
                  <span className="truncate text-slate-200">{n.label}</span>
                  {value?.text != null && (
                    <span key={value.key} className="valueflash mono ml-auto truncate text-xs text-accent-200" style={{ maxWidth: 150 }}>
                      {value.text}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
