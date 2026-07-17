import { useState } from 'react';
import { Sparkles, RotateCw, ChevronDown, ChevronUp, Tag, Activity, Circle } from 'lucide-react';
import clsx from 'clsx';

/**
 * Look-and-feel controls for the 3D graph view: Beautify (depth-graded colours,
 * glowing links, slow spin), auto-rotate, a Values toggle, and node-size /
 * link-opacity / label-density sliders. Shared by every 3D graph.
 */
export default function Graph3DControls({
  beautify,
  onBeautify,
  autoRotate,
  onAutoRotate,
  nodeScale,
  onNodeScale,
  linkOpacity,
  onLinkOpacity,
  labelDensity,
  onLabelDensity,
  showValues,
  onShowValues,
  nodeShape,
  onNodeShape,
  flow,
  onFlow,
  activitySize,
  onActivitySize
}) {
  const [open, setOpen] = useState(false);
  const shapes = [
    { id: 'sphere', label: '●' },
    { id: 'cube', label: '■' },
    { id: 'diamond', label: '◆' },
    { id: 'tetra', label: '▲' },
    { id: 'icosa', label: '⬡' }
  ];
  return (
    <div className="absolute left-4 top-4 z-10 w-52 overflow-hidden rounded-xl border border-white/10 bg-surface-900/80 text-slate-300 backdrop-blur">
      <div className="flex items-stretch">
        <button
          onClick={onBeautify}
          title="Depth-graded colours, glowing links, and a slow spin"
          className={clsx(
            'flex flex-1 items-center gap-1.5 px-3 py-2 text-sm font-medium transition',
            beautify ? 'bg-accent-500/20 text-accent-200' : 'text-slate-300 hover:text-slate-100'
          )}
        >
          <Sparkles size={15} className={beautify ? 'text-accent-300' : ''} /> Beautify
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          title="Look and feel"
          className="border-l border-white/10 px-2.5 text-slate-400 transition hover:text-slate-200"
        >
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      {open && (
        <div className="space-y-3 border-t border-white/5 px-3 py-3">
          <div className="flex flex-wrap gap-2">
            {onFlow && (
              <button
                onClick={onFlow}
                title="Flash nodes as messages arrive"
                className={clsx(
                  'flex min-w-[64px] flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition',
                  flow ? 'border-accent-500/40 bg-accent-500/15 text-accent-200' : 'border-white/10 text-slate-400 hover:text-slate-200'
                )}
              >
                <Activity size={13} className={clsx(flow && 'animate-pulse text-accent-300')} /> Flow
              </button>
            )}
            {onActivitySize && (
              <button
                onClick={onActivitySize}
                title="Swell nodes by their live message rate"
                className={clsx(
                  'flex min-w-[64px] flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition',
                  activitySize ? 'border-accent-500/40 bg-accent-500/15 text-accent-200' : 'border-white/10 text-slate-400 hover:text-slate-200'
                )}
              >
                <Circle size={13} className={activitySize ? 'text-accent-300' : ''} /> Activity
              </button>
            )}
            <button
              onClick={onAutoRotate}
              className={clsx(
                'flex min-w-[64px] flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition',
                autoRotate ? 'border-accent-500/40 bg-accent-500/15 text-accent-200' : 'border-white/10 text-slate-400 hover:text-slate-200'
              )}
            >
              <RotateCw size={13} className={autoRotate ? 'text-accent-300' : ''} /> Rotate
            </button>
            {onShowValues && (
              <button
                onClick={onShowValues}
                title="Show each labelled node's latest value"
                className={clsx(
                  'flex min-w-[64px] flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition',
                  showValues ? 'border-accent-500/40 bg-accent-500/15 text-accent-200' : 'border-white/10 text-slate-400 hover:text-slate-200'
                )}
              >
                <Tag size={13} className={showValues ? 'text-accent-300' : ''} /> Values
              </button>
            )}
          </div>
          {onNodeShape && (
            <div>
              <span className="mb-1 block text-[11px] text-slate-400">Node shape</span>
              <div className="flex gap-1">
                {shapes.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => onNodeShape(s.id)}
                    title={s.id}
                    className={clsx(
                      'flex-1 rounded-md border py-1 text-sm transition',
                      nodeShape === s.id ? 'border-accent-500/50 bg-accent-500/15 text-accent-200' : 'border-white/10 text-slate-400 hover:text-slate-200'
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {onLabelDensity && (
            <label className="block">
              <span className="mb-1 flex justify-between text-[11px] text-slate-400">
                Labels <span className="tabular-nums text-slate-500">{labelDensity <= 0.001 ? 'off' : `${Math.round(labelDensity * 100)}%`}</span>
              </span>
              <input type="range" min="0" max="1" step="0.05" value={labelDensity} onChange={(e) => onLabelDensity(Number(e.target.value))} className="w-full accent-accent-500" />
            </label>
          )}
          <label className="block">
            <span className="mb-1 flex justify-between text-[11px] text-slate-400">
              Node size <span className="tabular-nums text-slate-500">{nodeScale.toFixed(1)}×</span>
            </span>
            <input type="range" min="0.5" max="2" step="0.1" value={nodeScale} onChange={(e) => onNodeScale(Number(e.target.value))} className="w-full accent-accent-500" />
          </label>
          <label className="block">
            <span className="mb-1 flex justify-between text-[11px] text-slate-400">
              Links <span className="tabular-nums text-slate-500">{Math.round(linkOpacity * 100)}%</span>
            </span>
            <input type="range" min="0.05" max="0.8" step="0.05" value={linkOpacity} onChange={(e) => onLinkOpacity(Number(e.target.value))} className="w-full accent-accent-500" />
          </label>
        </div>
      )}
    </div>
  );
}
