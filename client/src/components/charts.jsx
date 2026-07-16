import { useId } from 'react';
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
/* eslint-disable react/no-unknown-property */

/**
 * Shared chart components — every sparkline and time-series in the app renders
 * through these (Recharts) so they look and behave as one system: same accent,
 * same grid, same tooltip, same number formatting. Dark-theme tuned.
 */

const ACCENT = '#38bdf8';
const GRID = 'rgba(255,255,255,0.06)';
const AXIS = '#64748b';

export function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a !== 0 && (a < 0.001 || a >= 1e6)) return n.toExponential(2);
  return Number(n.toFixed(a < 1 ? 4 : a < 100 ? 2 : 1)).toString();
}

/**
 * Compact inline sparkline. `values` is a number[] (or []). Optional `warn`
 * flips the color to amber. No axes, no interaction — for stat tiles etc.
 */
export function Sparkline({ values, height = 28, warn = false, area = true }) {
  const id = useId().replace(/:/g, '');
  const color = warn ? '#f59e0b' : ACCENT;
  const data = (values || []).map((v, i) => ({ i, v }));
  if (data.length < 2) return <div style={{ height, width: '100%' }} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 3, right: 1, bottom: 3, left: 1 }}>
        <defs>
          <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={area ? 0.3 : 0} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} fill={`url(#spark-${id})`} isAnimationActive={false} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

const tooltipStyle = {
  background: '#0f1a2b',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 10,
  fontSize: 12,
  color: '#e6edf5',
  boxShadow: '0 10px 30px -12px rgba(0,0,0,0.6)'
};

function TimeTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ ...tooltipStyle, padding: '8px 10px' }}>
      <div style={{ color: '#94a3b8', marginBottom: 4, fontFamily: 'ui-monospace, monospace' }}>
        {new Date(label).toLocaleTimeString()}
      </div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
          <span style={{ color: '#cbd5e1', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
          <span style={{ marginLeft: 'auto', fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}>{fmtNum(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Time-series line/area chart. `series` is the historian shape:
 *   [{ tag, points: [[tsMs, value], ...] }]
 * Multiple series are merged on their union of timestamps (nulls connected), so
 * one series (a topic-history popup) or ten (Trends) render the same way.
 * `colorFor(index)` supplies per-series colors; a single series gets an area fill.
 */
export function TimeSeriesChart({ series = [], height = 260, colorFor, area, showGrid = true }) {
  const single = series.length === 1;
  const useArea = area ?? single;

  // Merge every series onto a shared, sorted timestamp axis.
  const rows = new Map();
  series.forEach((s, si) => {
    for (const [ts, v] of s.points || []) {
      if (!Number.isFinite(ts) || v == null) continue;
      const row = rows.get(ts) || { ts };
      row[`s${si}`] = v;
      rows.set(ts, row);
    }
  });
  const data = [...rows.values()].sort((a, b) => a.ts - b.ts);
  const color = (i) => (colorFor ? colorFor(i) : ACCENT);
  const gid = useId().replace(/:/g, '');

  const xAxis = (
    <XAxis
      dataKey="ts"
      type="number"
      scale="time"
      domain={['dataMin', 'dataMax']}
      tickFormatter={(ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      stroke={AXIS}
      tick={{ fontSize: 11, fill: AXIS }}
      minTickGap={40}
    />
  );
  const yAxis = <YAxis stroke={AXIS} tick={{ fontSize: 11, fill: AXIS }} width={44} tickFormatter={fmtNum} domain={['auto', 'auto']} />;
  const grid = showGrid ? <CartesianGrid stroke={GRID} vertical={false} /> : null;
  const tip = <Tooltip content={<TimeTooltip />} />;

  // Single series → filled area; multiple → clean lines.
  if (useArea) {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <defs>
            <linearGradient id={`ts-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color(0)} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color(0)} stopOpacity={0} />
            </linearGradient>
          </defs>
          {grid}
          {xAxis}
          {yAxis}
          {tip}
          <Area type="monotone" dataKey="s0" name={series[0]?.tag} stroke={color(0)} strokeWidth={2} fill={`url(#ts-${gid})`} dot={false} connectNulls isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        {grid}
        {xAxis}
        {yAxis}
        {tip}
        {series.map((s, i) => (
          <Line key={s.tag || i} type="monotone" dataKey={`s${i}`} name={s.tag} stroke={color(i)} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
