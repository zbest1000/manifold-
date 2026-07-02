import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import clsx from 'clsx';

/** Compact, dependency-free collapsible JSON tree with syntax coloring. */
export default function JsonView({ data, name = null, depth = 0, defaultOpen = true }) {
  const [open, setOpen] = useState(depth < 2 ? defaultOpen : false);

  if (data === null) return <Leaf name={name} value="null" cls="text-slate-500" />;
  if (typeof data === 'number') return <Leaf name={name} value={String(data)} cls="text-amber-300" />;
  if (typeof data === 'boolean') return <Leaf name={name} value={String(data)} cls="text-purple-300" />;
  if (typeof data === 'string') return <Leaf name={name} value={`"${data}"`} cls="text-emerald-300" />;

  const isArray = Array.isArray(data);
  const entries = isArray ? data.map((v, i) => [i, v]) : Object.entries(data || {});
  const bracket = isArray ? ['[', ']'] : ['{', '}'];

  if (entries.length === 0) {
    return <Leaf name={name} value={`${bracket[0]}${bracket[1]}`} cls="text-slate-500" />;
  }

  return (
    <div className="mono text-xs leading-relaxed">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded hover:bg-white/5"
      >
        <ChevronRight size={12} className={clsx('text-slate-500 transition', open && 'rotate-90')} />
        {name !== null && <span className="text-sky-300">{name}: </span>}
        <span className="text-slate-500">
          {bracket[0]}
          {!open && <span className="px-1 text-slate-600">{entries.length} items</span>}
          {!open && bracket[1]}
        </span>
      </button>
      {open && (
        <div className="border-l border-white/5 pl-4">
          {entries.map(([k, v]) => (
            <JsonView key={k} name={String(k)} data={v} depth={depth + 1} />
          ))}
          <div className="text-slate-500">{bracket[1]}</div>
        </div>
      )}
    </div>
  );
}

function Leaf({ name, value, cls }) {
  return (
    <div className="mono text-xs leading-relaxed">
      {name !== null && <span className="text-sky-300">{name}: </span>}
      <span className={cls}>{value}</span>
    </div>
  );
}
