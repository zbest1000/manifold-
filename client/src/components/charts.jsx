import { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import './charts-uplot.css';

/**
 * Shared chart components — every sparkline and time-series in the app renders
 * through these. They wrap uPlot (https://github.com/leeoniya/uPlot): a mature,
 * dependency-free, ~40KB canvas charting engine — the same rendering approach
 * Grafana's time-series panels use. We don't draw axes/lines/tooltips ourselves;
 * uPlot does, so every chart shares one look, one crosshair, one readout.
 */

const ACCENT = '#38bdf8';
const GRID = 'rgba(148,163,184,0.14)';
const AXIS = '#7c8aa0';

export function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a !== 0 && (a < 0.001 || a >= 1e6)) return n.toExponential(2);
  return Number(n.toFixed(a < 1 ? 4 : a < 100 ? 2 : 1)).toString();
}

// #rrggbb → rgba(...) with the given alpha.
function withAlpha(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// Pad the y-scale so a trace has breathing room instead of jamming edge-to-edge;
// a constant series (min===max) gets a symmetric band so it reads as a flat line.
function paddedRange(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min - 1, max + 1];
  const pad = (max - min) * 0.35;
  return [min - pad, max + pad];
}

// Vertical gradient fill under an area series (returns a canvas gradient uPlot
// paints each draw). Falls back to a flat wash before the plot box is measured
// (bbox is empty on the very first draw) — createLinearGradient throws on
// non-finite coordinates.
function areaFill(hex) {
  return (u) => {
    const top = u.bbox?.top;
    const h = u.bbox?.height;
    if (!Number.isFinite(top) || !Number.isFinite(h) || h <= 0) return withAlpha(hex, 0.14);
    const g = u.ctx.createLinearGradient(0, top, 0, top + h);
    g.addColorStop(0, withAlpha(hex, 0.28));
    g.addColorStop(1, withAlpha(hex, 0));
    return g;
  };
}

/**
 * Minimal responsive uPlot lifecycle wrapper: creates the chart sized to its
 * container, keeps it sized via a ResizeObserver, and pushes data updates
 * through setData (no teardown) so live charts stay cheap. The chart is only
 * rebuilt when `options` changes (a structural change — series count, colors).
 */
function UplotChart({ options, data, height, className }) {
  const wrapRef = useRef(null);
  const uRef = useRef(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const width = Math.max(Math.floor(el.clientWidth), 1);
    const u = new uPlot({ ...options, width, height }, data, el);
    uRef.current = u;
    const ro = new ResizeObserver(() => u.setSize({ width: Math.max(Math.floor(el.clientWidth), 1), height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      uRef.current = null;
    };
    // data is intentionally omitted — updates flow through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, height]);

  useEffect(() => {
    if (uRef.current) uRef.current.setData(data);
  }, [data]);

  return <div ref={wrapRef} className={className} style={{ width: '100%', height }} />;
}

/**
 * Compact inline sparkline. `values` is a number[] (or []). Optional `warn`
 * flips the color to amber. No axes/legend/cursor — for stat tiles etc.
 */
export function Sparkline({ values, height = 28, warn = false, area = true }) {
  const color = warn ? '#f59e0b' : ACCENT;
  const nums = (values || []).filter((v) => Number.isFinite(v));
  const flat = nums.length >= 2 && Math.min(...nums) === Math.max(...nums);
  const data = useMemo(() => [nums.map((_, i) => i), nums], [values]); // eslint-disable-line react-hooks/exhaustive-deps
  const options = useMemo(
    () => ({
      cursor: { show: false },
      legend: { show: false },
      scales: { x: { time: false }, y: { range: (_u, dmin, dmax) => paddedRange(dmin, dmax) } },
      axes: [{ show: false }, { show: false }],
      series: [
        {},
        {
          stroke: flat ? withAlpha(color, 0.45) : color,
          width: 1.5,
          fill: area && !flat ? areaFill(color) : undefined,
          points: { show: false }
        }
      ]
    }),
    [color, area, flat]
  );
  if (nums.length < 2) return <div style={{ height, width: '100%' }} />;
  return <UplotChart options={options} data={data} height={height} className="u-spark" />;
}

/**
 * Time-series line/area chart. `series` is the historian shape:
 *   [{ tag, points: [[tsMs, value], ...] }]
 * Multiple series are merged on their union of timestamps (gaps → null), so one
 * series (a topic-history popup) or ten (Trends) render the same way.
 * `colorFor(index)` supplies per-series colors; a single series gets an area fill.
 */
export function TimeSeriesChart({ series = [], height = 260, colorFor, area, showGrid = true }) {
  const single = series.length === 1;
  const useArea = (area ?? single) && single;
  const color = (i) => (colorFor ? colorFor(i) : ACCENT);

  // uPlot data: shared, sorted x in SECONDS (its time scale), each series
  // aligned with nulls for gaps.
  const data = useMemo(() => {
    const tsSet = new Set();
    for (const s of series) for (const [ts, v] of s.points || []) if (Number.isFinite(ts) && v != null) tsSet.add(ts);
    const xsMs = [...tsSet].sort((a, b) => a - b);
    const idx = new Map(xsMs.map((t, i) => [t, i]));
    const ys = series.map((s) => {
      const arr = new Array(xsMs.length).fill(null);
      for (const [ts, v] of s.points || []) if (idx.has(ts)) arr[idx.get(ts)] = v;
      return arr;
    });
    return [xsMs.map((t) => t / 1000), ...ys];
  }, [series]);

  // Structural signature: the SET of series (tags + count), NOT their data. The
  // chart is only rebuilt when this changes — live data updates flow through
  // uPlot's setData (see UplotChart), so a 3s poll no longer destroys and
  // recreates the chart (which flashed and reset any zoom).
  const structKey = series.map((s) => s.tag || '').join('|');
  const options = useMemo(
    () => ({
      padding: [10, 14, 2, 2],
      cursor: { show: true, points: { show: true, size: 6 }, focus: { prox: 24 } },
      legend: { show: series.length > 0, live: true },
      scales: { x: { time: true }, y: { range: (_u, dmin, dmax) => paddedRange(dmin, dmax) } },
      axes: [
        { stroke: AXIS, grid: { show: false }, ticks: { stroke: GRID, size: 4 }, font: '11px ui-sans-serif, system-ui', space: 60 },
        {
          stroke: AXIS,
          grid: { show: showGrid, stroke: GRID, width: 1 },
          ticks: { show: false },
          font: '11px ui-sans-serif, system-ui',
          size: 52,
          values: (_u, ticks) => ticks.map(fmtNum)
        }
      ],
      series: [
        { value: (_u, ts) => (ts == null ? '' : new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })) },
        ...series.map((s, i) => ({
          label: s.tag || `series ${i + 1}`,
          stroke: color(i),
          width: 2,
          fill: useArea ? areaFill(color(i)) : undefined,
          points: { show: false },
          spanGaps: true,
          value: (_u, v) => (v == null ? '—' : fmtNum(v))
        }))
      ]
    }),
    // Rebuild ONLY on a structural change (series added/removed, area/grid
    // toggled) — never on new data points, which stream through setData.
    [structKey, useArea, showGrid] // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (!data[0] || data[0].length < 2) {
    return (
      <div style={{ height }} className="grid place-items-center text-xs text-slate-500">
        Not enough data to chart yet.
      </div>
    );
  }
  return <UplotChart options={options} data={data} height={height} className="u-ts" />;
}
