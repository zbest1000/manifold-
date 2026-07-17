import { useState } from 'react';
import { Sparkles, RotateCw, ChevronDown, ChevronUp } from 'lucide-react';
import clsx from 'clsx';

/**
 * Look-and-feel controls for the 3D graph view: Beautify (depth-graded colours,
 * glowing links, slow spin), an auto-rotate toggle, and node-size / link-opacity
 * sliders. Shared by every 3D graph (Topics, i3X, OPC UA).
 */
export default function Graph3DControls({ beautify, onBeautify, autoRotate, onAutoRotate, nodeScale, onNodeScale, linkOpacity, onLinkOpacity }) {
  const [open, setOpen] = useState(false);
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
          <button
            onClick={onAutoRotate}
            className={clsx(
              'flex w-full items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition',
              autoRotate ? 'border-accent-500/40 bg-accent-500/15 text-accent-200' : 'border-white/10 text-slate-400 hover:text-slate-200'
            )}
          >
            <RotateCw size={13} className={autoRotate ? 'text-accent-300' : ''} /> Auto-rotate
          </button>
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
