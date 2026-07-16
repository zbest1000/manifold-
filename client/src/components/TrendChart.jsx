import { LineChart as LineIcon, Loader2, AlertTriangle } from 'lucide-react';
import { TimeSeriesChart } from './charts';

/**
 * TrendChart — the Trends page's multi-series time chart. Thin wrapper over the
 * shared Recharts TimeSeriesChart so every chart in the app looks the same;
 * keeps the loading / error / empty states, the categorical palette, and a
 * click-free legend.
 *
 * `series`: [{ tag, points: [[tsMs, value], ...] }]
 */

// Fixed slot order — assigned by series position, CVD-separated, >=3:1 contrast
// on the dark surface. Slots 9-10 reuse 1-2 (identity stays via the legend).
const PALETTE = ['#3987e5', '#22c55e', '#e879a6', '#eab308', '#2dd4bf', '#f97316', '#a78bfa', '#f87171'];

export function seriesColor(i) {
  return PALETTE[i % PALETTE.length];
}

function State({ icon: Icon, tone = 'slate', children }) {
  const color = tone === 'error' ? 'text-rose-400' : 'text-slate-500';
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <Icon size={22} className={tone === 'error' ? 'text-rose-400' : color} />
      <p className={`max-w-md text-xs ${tone === 'error' ? 'text-rose-300' : 'text-slate-500'}`}>{children}</p>
    </div>
  );
}

export default function TrendChart({ series = [], loading = false, error = '', height = 380 }) {
  const totalPoints = series.reduce((n, s) => n + (s.points?.length || 0), 0);
  const state = error ? 'error' : loading && !totalPoints ? 'loading' : series.length === 0 ? 'empty' : totalPoints === 0 ? 'nodata' : 'chart';

  return (
    <div>
      <div className="w-full" style={{ height }}>
        {state === 'error' && (
          <State icon={AlertTriangle} tone="error">
            {error}
          </State>
        )}
        {state === 'loading' && (
          <State icon={Loader2}>
            <span className="inline-flex items-center gap-1.5">Querying…</span>
          </State>
        )}
        {state === 'empty' && <State icon={LineIcon}>Pick a source and add tags to trend.</State>}
        {state === 'nodata' && <State icon={LineIcon}>No samples for these tags in this time range.</State>}
        {state === 'chart' && <TimeSeriesChart series={series} height={height} colorFor={seriesColor} />}
      </div>
      {state === 'chart' && series.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
          {series.map((s, i) => (
            <span key={s.tag || i} className="flex items-center gap-1.5 text-2xs text-slate-400">
              <span className="h-2 w-2 rounded-full" style={{ background: seriesColor(i) }} />
              <span className="mono max-w-[220px] truncate">{s.tag}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
