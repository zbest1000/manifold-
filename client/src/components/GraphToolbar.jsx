import { useState } from 'react';
import { Palette, Shuffle, Check, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { STYLE_LIST, LAYOUT_LIST } from '@/graph/graphStyles';
import { useStore } from '@/store/store';

/** Floating toolbar for choosing the node-graph visual style and layout. */
export default function GraphToolbar() {
  const { graphStyle, graphLayout, setGraphStyle, setGraphLayout } = useStore();
  const [open, setOpen] = useState(false);

  const active = STYLE_LIST.find((s) => s.id === graphStyle) || STYLE_LIST[0];

  return (
    <div className="pointer-events-auto absolute right-4 top-4 z-10 flex flex-col items-end gap-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-xl border border-white/10 bg-surface-900/80 px-3 py-2 text-sm text-slate-200 backdrop-blur transition hover:border-white/20 hover:bg-surface-900"
      >
        <Palette size={16} className="text-accent-400" />
        <span className="font-medium">{active.name}</span>
        <ChevronDown size={14} className={clsx('transition', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="w-72 rounded-2xl border border-white/10 bg-surface-900/95 p-3 shadow-2xl backdrop-blur">
          <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Visual style</p>
          <div className="grid grid-cols-2 gap-2">
            {STYLE_LIST.map((style) => (
              <button
                key={style.id}
                onClick={() => setGraphStyle(style.id)}
                title={style.description}
                className={clsx(
                  'group relative overflow-hidden rounded-xl border p-0.5 text-left transition',
                  style.id === graphStyle
                    ? 'border-accent-500/70 ring-1 ring-accent-500/40'
                    : 'border-white/10 hover:border-white/25'
                )}
              >
                <StylePreview style={style} />
                <div className="flex items-center justify-between px-2 py-1.5">
                  <span className="text-xs font-medium text-slate-200">{style.name}</span>
                  {style.id === graphStyle && <Check size={13} className="text-accent-400" />}
                </div>
              </button>
            ))}
          </div>

          <p className="mb-2 mt-4 px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Layout</p>
          <div className="flex gap-2">
            {LAYOUT_LIST.map((layout) => (
              <button
                key={layout.id}
                onClick={() => setGraphLayout(layout.id)}
                className={clsx(
                  'flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition',
                  layout.id === graphLayout
                    ? 'border-accent-500/70 bg-accent-500/10 text-accent-300'
                    : 'border-white/10 text-slate-300 hover:border-white/25'
                )}
              >
                <Shuffle size={12} />
                {layout.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// A tiny swatch preview built from the style's own palette + background.
function StylePreview({ style }) {
  return (
    <div className="relative h-12 w-full overflow-hidden rounded-lg" style={{ background: style.background }}>
      <svg viewBox="0 0 100 48" className="h-full w-full">
        <line x1="24" y1="30" x2="50" y2="16" stroke={style.link.color} strokeWidth="1" />
        <line x1="50" y1="16" x2="76" y2="30" stroke={style.link.color} strokeWidth="1" />
        <line x1="50" y1="16" x2="50" y2="38" stroke={style.link.color} strokeWidth="1" />
        {[
          { x: 24, y: 30, r: 4, c: style.palette[0] },
          { x: 50, y: 16, r: 6, c: style.palette[1] || style.palette[0] },
          { x: 76, y: 30, r: 4, c: style.palette[2] || style.palette[0] },
          { x: 50, y: 38, r: 3.5, c: style.palette[3] || style.palette[0] }
        ].map((n, i) => (
          <circle
            key={i}
            cx={n.x}
            cy={n.y}
            r={n.r}
            fill={n.c}
            stroke={style.node.stroke}
            strokeWidth={style.node.strokeWidth || 0}
          />
        ))}
      </svg>
    </div>
  );
}
