import { useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import clsx from 'clsx';
import { LineChart, Loader2, AlertTriangle } from 'lucide-react';

/**
 * TrendChart — hand-rolled SVG multi-series time chart (no chart deps).
 *
 * - time-scaled x axis, 5-7 ticks, HH:mm within 48h / MM-dd HH:mm beyond
 * - y axis with nice()-rounded ticks
 * - per-series polylines from a fixed categorical palette (validated for
 *   CVD separation and >=3:1 contrast on this app's dark surface; series
 *   9-10 reuse slots 1-2 with a dash pattern so identity is never hue-alone)
 * - shared-crosshair hover: one vertical line, a dot per series, tooltip
 *   listing every series value at the nearest bucket timestamp
 * - legend with click-to-toggle series visibility
 * - responsive: ResizeObserver-measured container drives the viewBox
 */

// Fixed slot order — assigned by series position, never cycled per render.
const PALETTE = ['#3987e5', '#008300', '#d55181', '#c98500', '#199e70', '#d95926', '#9085e9', '#e66767'];

export function seriesColor(i) {
  return PALETTE[i % PALETTE.length];
}

function seriesDash(i) {
  return i >= PALETTE.length ? '6 4' : undefined;
}

// Candidate x-tick steps (ms), smallest that yields <= 7 ticks wins.
const TIME_STEPS = [
  30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000,
  3_600_000, 2 * 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000,
  86_400_000, 2 * 86_400_000, 7 * 86_400_000
];

function timeTicks(min, max) {
  const span = max - min;
  const step = TIME_STEPS.find((s) => span / s <= 7) || TIME_STEPS[TIME_STEPS.length - 1];
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) ticks.push(t);
  return ticks;
}

function formatTick(ts, spanMs) {
  return format(new Date(ts), spanMs <= 48 * 3_600_000 ? 'HH:mm' : 'MM-dd HH:mm');
}

/** nice() axis: round the domain out to a 1/2/5×10^n step, ~5 ticks. */
function niceScale(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 0.5, 1] };
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad / 2;
    max += pad / 2;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  return { lo, hi, ticks };
}

function formatValue(v) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e6 || abs < 0.001)) return v.toExponential(2);
  return String(Math.round(v * 1000) / 1000);
}

function nearestIndex(sorted, t) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1] - t) <= Math.abs(sorted[lo] - t)) return lo - 1;
  return lo;
}

const MARGIN = { top: 14, right: 18, bottom: 30, left: 58 };

export default function TrendChart({ series = [], start, end, loading = false, error = '', height = 380 }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(800);
  const [hidden, setHidden] = useState(() => new Set());
  const [hover, setHover] = useState(null); // { t, px, rows: [{tag, color, value, y}] }

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w) setWidth(Math.max(320, Math.round(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = useMemo(() => series.filter((s) => !hidden.has(s.tag)), [series, hidden]);
  const totalPoints = useMemo(() => series.reduce((n, s) => n + (s.points?.length || 0), 0), [series]);

  const plot = useMemo(() => {
    const innerW = Math.max(10, width - MARGIN.left - MARGIN.right);
    const innerH = Math.max(10, height - MARGIN.top - MARGIN.bottom);
    let xMin = Number.isFinite(start) ? start : Infinity;
    let xMax = Number.isFinite(end) ? end : -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const s of visible) {
      for (const [t, v] of s.points || []) {
        if (!Number.isFinite(start)) xMin = Math.min(xMin, t);
        if (!Number.isFinite(end)) xMax = Math.max(xMax, t);
        yMin = Math.min(yMin, v);
        yMax = Math.max(yMax, v);
      }
    }
    if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || xMin === xMax) {
      xMax = Date.now();
      xMin = xMax - 3_600_000;
    }
    if (!Number.isFinite(yMin)) {
      yMin = 0;
      yMax = 1;
    }
    const yScale = niceScale(yMin, yMax);
    const x = (t) => MARGIN.left + ((t - xMin) / (xMax - xMin)) * innerW;
    const y = (v) => MARGIN.top + innerH - ((v - yScale.lo) / (yScale.hi - yScale.lo || 1)) * innerH;
    // Union of visible timestamps (buckets are backend-aligned, so series share them).
    const stamps = new Set();
    for (const s of visible) for (const [t] of s.points || []) stamps.add(t);
    return {
      innerW, innerH, xMin, xMax, x, y,
      yTicks: yScale.ticks,
      xTicks: timeTicks(xMin, xMax),
      span: xMax - xMin,
      timeIndex: [...stamps].sort((a, b) => a - b),
      valueAt: new Map(visible.map((s) => [s.tag, new Map(s.points || [])]))
    };
  }, [visible, width, height, start, end]);

  const onMove = (e) => {
    if (!plot.timeIndex.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // The svg is viewBox-scaled to the container, so map client px → chart units.
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const t = plot.xMin + ((px - MARGIN.left) / plot.innerW) * (plot.xMax - plot.xMin);
    const T = plot.timeIndex[nearestIndex(plot.timeIndex, t)];
    const rows = [];
    series.forEach((s, i) => {
      if (hidden.has(s.tag)) return;
      const v = plot.valueAt.get(s.tag)?.get(T);
      if (v !== undefined) rows.push({ tag: s.tag, color: seriesColor(i), value: v, y: plot.y(v) });
    });
    if (rows.length) setHover({ t: T, px: plot.x(T), rows });
    else setHover(null);
  };

  const toggle = (tag) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });

  const state = error ? 'error' : loading && !totalPoints ? 'loading' : series.length === 0 ? 'empty' : totalPoints === 0 ? 'nodata' : 'chart';

  return (
    <div>
      <div ref={containerRef} className="relative w-full" style={{ height }}>
        {state === 'error' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <AlertTriangle size={22} className="text-rose-400" />
            <p className="max-w-md text-xs text-rose-300">{error}</p>
          </div>
        )}
        {state === 'loading' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
            <Loader2 size={22} className="animate-spin" />
            <p className="text-xs">Querying historian…</p>
          </div>
        )}
        {state === 'empty' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-500">
            <LineChart size={22} />
            <p className="text-xs">Pick a historian and add tags to trend.</p>
          </div>
        )}
        {state === 'nodata' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-500">
            <LineChart size={22} />
            <p className="text-xs">No samples for these tags in this time range.</p>
          </div>
        )}
        {state === 'chart' && (
          <>
            <svg
              viewBox={`0 0 ${width} ${height}`}
              preserveAspectRatio="xMidYMid meet"
              className="block h-full w-full cursor-crosshair"
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
            >
              {/* grid + y axis */}
              {plot.yTicks.map((v) => (
                <g key={`y${v}`}>
                  <line
                    x1={MARGIN.left}
                    x2={width - MARGIN.right}
                    y1={plot.y(v)}
                    y2={plot.y(v)}
                    stroke="rgba(255,255,255,0.06)"
                    strokeWidth="1"
                  />
                  <text x={MARGIN.left - 8} y={plot.y(v) + 3.5} textAnchor="end" fontSize="10" fill="#64748b">
                    {formatValue(v)}
                  </text>
                </g>
              ))}
              {/* x axis */}
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={height - MARGIN.bottom}
                y2={height - MARGIN.bottom}
                stroke="rgba(255,255,255,0.12)"
                strokeWidth="1"
              />
              {plot.xTicks.map((t) => (
                <g key={`x${t}`}>
                  <line
                    x1={plot.x(t)}
                    x2={plot.x(t)}
                    y1={height - MARGIN.bottom}
                    y2={height - MARGIN.bottom + 4}
                    stroke="rgba(255,255,255,0.2)"
                    strokeWidth="1"
                  />
                  <text x={plot.x(t)} y={height - MARGIN.bottom + 16} textAnchor="middle" fontSize="10" fill="#64748b">
                    {formatTick(t, plot.span)}
                  </text>
                </g>
              ))}
              {/* series */}
              {series.map((s, i) =>
                hidden.has(s.tag) || !(s.points || []).length ? null : (
                  <polyline
                    key={s.tag}
                    fill="none"
                    stroke={seriesColor(i)}
                    strokeWidth="2"
                    strokeDasharray={seriesDash(i)}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    points={s.points.map(([t, v]) => `${plot.x(t).toFixed(1)},${plot.y(v).toFixed(1)}`).join(' ')}
                  />
                )
              )}
              {/* shared crosshair + per-series dots */}
              {hover && (
                <g pointerEvents="none">
                  <line
                    x1={hover.px}
                    x2={hover.px}
                    y1={MARGIN.top}
                    y2={height - MARGIN.bottom}
                    stroke="rgba(255,255,255,0.25)"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                  />
                  {hover.rows.map((r) => (
                    <circle key={r.tag} cx={hover.px} cy={r.y} r="4" fill={r.color} stroke="#0f172a" strokeWidth="1.5" />
                  ))}
                </g>
              )}
            </svg>
            {hover && (
              <div
                className="pointer-events-none absolute top-3 z-10 max-w-xs rounded-xl border border-white/10 bg-surface-900/95 px-3 py-2 text-xs shadow-xl backdrop-blur"
                style={
                  (hover.px / width) * 100 > 55
                    ? { right: `${100 - (hover.px / width) * 100 + 2}%` }
                    : { left: `${(hover.px / width) * 100 + 2}%` }
                }
              >
                <p className="mb-1 font-medium text-slate-300">{format(new Date(hover.t), 'MM-dd HH:mm:ss')}</p>
                <div className="space-y-0.5">
                  {hover.rows.map((r) => (
                    <div key={r.tag} className="flex items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-1.5 text-slate-400">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />
                        <span className="truncate">{r.tag}</span>
                      </span>
                      <span className="mono text-slate-200">{formatValue(r.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {loading && totalPoints > 0 && (
          <div className="absolute right-2 top-2 text-slate-500">
            <Loader2 size={14} className="animate-spin" />
          </div>
        )}
      </div>

      {/* legend — click to toggle a series */}
      {series.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 px-1">
          {series.map((s, i) => (
            <button
              key={s.tag}
              type="button"
              onClick={() => toggle(s.tag)}
              title={hidden.has(s.tag) ? 'Show series' : 'Hide series'}
              className={clsx(
                'flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition hover:bg-white/5',
                hidden.has(s.tag) ? 'text-slate-600 line-through opacity-60' : 'text-slate-300'
              )}
            >
              <span
                className="h-0.5 w-4 shrink-0 rounded-full"
                style={{
                  background: hidden.has(s.tag)
                    ? '#475569'
                    : seriesDash(i)
                      ? `repeating-linear-gradient(90deg, ${seriesColor(i)} 0 4px, transparent 4px 7px)`
                      : seriesColor(i)
                }}
              />
              {s.tag}
              <span className="text-slate-600">({(s.points || []).length})</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
