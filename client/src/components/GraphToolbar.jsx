import { useState } from 'react';
import {
  Palette,
  Shuffle,
  Check,
  ChevronDown,
  Activity,
  Circle,
  Tag,
  Map as MapIcon,
  Download,
  Maximize2,
  Sparkles,
  PanelRight,
  ChevronsDownUp,
  ChevronsUpDown
} from 'lucide-react';
import clsx from 'clsx';
import { STYLE_LIST, LAYOUT_LIST } from '@/graph/graphStyles';
import { useStore } from '@/store/store';

/**
 * Floating toolbar for the node graph: quick toggles (flow, activity size,
 * values, minimap), fit + export actions, and a dropdown for visual style and
 * layout.
 *
 * `showFlow` gates message-flow controls to views with a live stream. Pass
 * `onFit` / `onExportPng` / `onExportJson` to enable those actions.
 */
export default function GraphToolbar({
  showFlow = false,
  onFit,
  onExportPng,
  onExportJson,
  layoutValue,
  onLayoutChange,
  onBeautify,
  beautifyActive,
  onProperties,
  hasSelection = false,
  onExpandLevel
}) {
  const {
    graphStyle,
    graphLayout,
    setGraphStyle,
    setGraphLayout,
    flowEnabled,
    setFlowEnabled,
    activitySize,
    setActivitySize,
    showValues,
    setShowValues,
    showMinimap,
    setShowMinimap
  } = useStore();
  const [open, setOpen] = useState(false);

  // Layout can be bound to the shared store (MQTT) or overridden per-view
  // (OPC UA / i3X default to a hierarchical layout without changing the global).
  const currentLayout = onLayoutChange ? layoutValue : graphLayout;
  const chooseLayout = onLayoutChange || setGraphLayout;

  const active = STYLE_LIST.find((s) => s.id === graphStyle) || STYLE_LIST[0];

  return (
    <div className="pointer-events-auto absolute right-4 top-4 z-10 flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {showFlow && (
          <Toggle active={flowEnabled} onClick={() => setFlowEnabled(!flowEnabled)} icon={Activity} label="Flow" pulse />
        )}
        {showFlow && (
          <Toggle active={activitySize} onClick={() => setActivitySize(!activitySize)} icon={Circle} label="Activity" />
        )}
        {onExpandLevel && (
          // Collapse to the top level, expand to a chosen depth, or expand all.
          // The tree/graph nests deep, so this is the fast way to steer it.
          <div className="flex overflow-hidden rounded-xl border border-white/10 bg-surface-900/80 backdrop-blur" title="Collapse / expand the tree">
            <button onClick={() => onExpandLevel(1)} title="Collapse to the top level" className="px-2 py-2 text-slate-300 hover:bg-white/10">
              <ChevronsDownUp size={15} />
            </button>
            {[2, 3, 4].map((l) => (
              <button
                key={l}
                onClick={() => onExpandLevel(l)}
                title={`Expand to level ${l}`}
                className="border-l border-white/10 px-2 py-2 text-[11px] font-medium text-slate-400 hover:bg-white/10 hover:text-slate-200"
              >
                {l}
              </button>
            ))}
            <button onClick={() => onExpandLevel(Infinity)} title="Expand all" className="border-l border-white/10 px-2 py-2 text-slate-300 hover:bg-white/10">
              <ChevronsUpDown size={15} />
            </button>
          </div>
        )}
        <Toggle active={showValues} onClick={() => setShowValues(!showValues)} icon={Tag} label="Values" />
        <Toggle active={showMinimap} onClick={() => setShowMinimap(!showMinimap)} icon={MapIcon} label="Map" />
        {onProperties && (
          // Open the selected node's details panel. A reliable, discoverable
          // replacement for right-click (which the OS/browser can swallow).
          <button
            onClick={() => hasSelection && onProperties()}
            disabled={!hasSelection}
            title={hasSelection ? 'Show properties of the selected node' : 'Select a node first'}
            className={clsx(
              'flex items-center gap-1.5 rounded-xl border px-2.5 py-2 text-sm backdrop-blur transition',
              hasSelection
                ? 'border-white/10 bg-surface-900/80 text-slate-300 hover:border-white/20 hover:text-slate-100'
                : 'cursor-not-allowed border-white/5 bg-surface-900/60 text-slate-600'
            )}
          >
            <PanelRight size={15} />
            <span className="hidden font-medium sm:inline">Properties</span>
          </button>
        )}
        {onBeautify && (
          // Beautify applies the radial arrangement. It's a toggle, so it lights
          // up only WHILE that layout is active (previously it was styled accent
          // permanently and looked stuck on).
          <Toggle active={beautifyActive ?? currentLayout === 'radial'} onClick={onBeautify} icon={Sparkles} label="Beautify" />
        )}
        {onFit && <IconButton onClick={() => onFit()} icon={Maximize2} title="Fit graph to view" />}
        {(onExportPng || onExportJson) && (
          <div className="flex overflow-hidden rounded-xl border border-white/10 bg-surface-900/80 backdrop-blur">
            {onExportPng && (
              <button onClick={onExportPng} title="Export PNG" className="px-2.5 py-2 text-slate-300 hover:bg-white/10">
                <Download size={15} />
              </button>
            )}
            {onExportJson && (
              <button
                onClick={onExportJson}
                title="Export JSON"
                className="border-l border-white/10 px-2 py-2 text-[11px] font-medium text-slate-400 hover:bg-white/10"
              >
                JSON
              </button>
            )}
          </div>
        )}
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 rounded-xl border border-white/10 bg-surface-900/80 px-3 py-2 text-sm text-slate-200 backdrop-blur transition hover:border-white/20 hover:bg-surface-900"
        >
          <Palette size={16} className="text-accent-400" />
          <span className="font-medium">{active.name}</span>
          <ChevronDown size={14} className={clsx('transition', open && 'rotate-180')} />
        </button>
      </div>

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
          <div className="grid grid-cols-3 gap-2">
            {LAYOUT_LIST.map((layout) => (
              <LayoutButton key={layout.id} layout={layout} active={layout.id === currentLayout} onClick={() => chooseLayout(layout.id)} icon={Shuffle} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LayoutButton({ layout, active, onClick, icon: Icon }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition',
        active ? 'border-accent-500/70 bg-accent-500/10 text-accent-300' : 'border-white/10 text-slate-300 hover:border-white/25'
      )}
    >
      <Icon size={11} />
      {layout.name}
    </button>
  );
}

function Toggle({ active, onClick, icon: Icon, label, pulse }) {
  return (
    <button
      onClick={onClick}
      title={`${label}: ${active ? 'on' : 'off'}`}
      className={clsx(
        'flex items-center gap-1.5 rounded-xl border px-2.5 py-2 text-sm backdrop-blur transition',
        active
          ? 'border-accent-500/60 bg-accent-500/15 text-accent-200'
          : 'border-white/10 bg-surface-900/80 text-slate-400 hover:border-white/20'
      )}
    >
      <Icon size={15} className={clsx(pulse && active && 'animate-pulse')} />
      <span className="hidden font-medium sm:inline">{label}</span>
    </button>
  );
}

function IconButton({ onClick, icon: Icon, title }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded-xl border border-white/10 bg-surface-900/80 px-2.5 py-2 text-slate-300 backdrop-blur transition hover:border-white/20 hover:text-slate-100"
    >
      <Icon size={15} />
    </button>
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
