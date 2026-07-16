import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Cpu, Radio, Workflow, Database, HardDriveDownload, ShieldCheck, BellRing, Tag, RefreshCw, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import PageHeader from '@/components/PageHeader';
import { Card, Button, EmptyState } from '@/components/ui';
import { Sparkline } from '@/components/charts';

/**
 * System — the tool that watches your namespace, watched. Parses Manifold's own
 * Prometheus /metrics exposition and renders every reading (process health,
 * per-broker ingest, pipeline/outbox/recorder/contract/alert/binding counters)
 * live, each with a rolling sparkline. Counters show their per-interval rate;
 * gauges show their value.
 */

const POLL_MS = 3000;
const HISTORY = 60; // ~3 min of 3s samples

// --- Prometheus text parsing -------------------------------------------------

function parsePrometheus(text) {
  const byKey = new Map();
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(.+)$/);
    if (!m) continue;
    const [, name, labelStr, valStr] = m;
    const value = Number(valStr);
    if (!Number.isFinite(value)) continue;
    const labels = {};
    if (labelStr) {
      for (const pair of labelStr.slice(1, -1).split(',')) {
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const k = pair.slice(0, eq).trim();
        let v = pair.slice(eq + 1).trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        labels[k] = v;
      }
    }
    byKey.set(name + (labelStr || ''), { name, labels, value });
  }
  return byKey;
}

const val = (byKey, name, labels) => {
  for (const s of byKey.values()) {
    if (s.name !== name) continue;
    if (labels && !Object.entries(labels).every(([k, v]) => s.labels[k] === v)) continue;
    return s.value;
  }
  return null;
};
const sumBy = (byKey, name, label) => {
  let total = 0;
  let any = false;
  for (const s of byKey.values()) {
    if (s.name === name && (!label || s.labels.result === label)) {
      total += s.value;
      any = true;
    }
  }
  return any ? total : null;
};
const distinctLabel = (byKey, name, label) => {
  const out = [];
  for (const s of byKey.values()) if (s.name === name && s.labels[label] !== undefined) out.push(s.labels[label]);
  return [...new Set(out)];
};

// --- formatting --------------------------------------------------------------

const fmtInt = (n) => (n == null ? '—' : Math.round(n).toLocaleString());
const fmtNum = (n, d = 1) => (n == null ? '—' : n.toFixed(d));
const fmtBytes = (n) => (n == null ? '—' : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);
function fmtUptime(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(sec % 60)}s`;
}

// --- sparkline ---------------------------------------------------------------

function StatTile({ label, value, unit, history, warn, sub }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${warn ? 'border-amber-500/30 bg-amber-500/[0.06]' : 'border-white/5 bg-white/[0.02]'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/* Wrap the label instead of truncating — "Delivered"/"Bindings published"
              were cut to "DELI…"/"BINDIN…" in the narrow tiles. */}
          <p className="text-2xs font-medium uppercase tracking-wide text-slate-500" title={label}>{label}</p>
          <p className={`mt-0.5 text-lg font-semibold tabular-nums ${warn ? 'text-amber-300' : 'text-slate-100'}`}>
            {value}
            {unit && <span className="ml-1 text-xs font-normal text-slate-500">{unit}</span>}
          </p>
          {sub && <p className="truncate text-2xs text-slate-500">{sub}</p>}
        </div>
        <div className="w-24 shrink-0">
          <Sparkline values={history} warn={warn} height={28} />
        </div>
      </div>
    </div>
  );
}

function Section({ icon: Icon, title, children, warn }) {
  return (
    <Card className="p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
        <Icon size={15} className={warn ? 'text-amber-400' : 'text-accent-400'} /> {title}
      </h2>
      {/* auto-fit so tiles never shrink below a label-readable width, whether the
          section is full-width or half-width */}
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        {children}
      </div>
    </Card>
  );
}

// last delta of a counter's history, per poll interval
const rate = (hist) => (hist && hist.length >= 2 ? Math.max(0, hist[hist.length - 1] - hist[hist.length - 2]) : 0);
const deltas = (hist) => (hist ? hist.slice(1).map((v, i) => Math.max(0, v - hist[i])) : []);

// Rolling history for a single-labelled (or unlabelled) series, keyed the same
// way poll() stores it.
function histFor(hist, name, labels) {
  const key = name + (labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '');
  return hist.get(key) || [];
}

// A gauge reading: current value (through `fmt`) plus a value sparkline.
function GaugeTile({ metrics, hist, name, labels, label, unit, sub, fmt = fmtInt, warn }) {
  return <StatTile label={label} value={fmt(val(metrics, name, labels))} unit={unit} sub={sub} warn={warn} history={histFor(hist, name, labels)} />;
}

// A counter reading: total value plus a per-interval-rate sparkline. `family` is
// the metric name; `result` an optional result-label filter; warnPositive flags
// amber once the value is non-zero.
function CounterTile({ metrics, hist, family, result, label, unit, warnPositive }) {
  const value = sumBy(metrics, family, result) || 0;
  return <StatTile label={label} value={fmtInt(value)} unit={unit} warn={warnPositive && value > 0} history={deltas(aggHistory(hist, family, result))} />;
}

export default function System() {
  const [metrics, setMetrics] = useState(null); // Map(key -> sample)
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const historyRef = useRef(new Map()); // key -> number[]

  const poll = useCallback(async () => {
    try {
      const text = await api.metricsText();
      const byKey = parsePrometheus(text);
      // Append every scalar into its rolling history for sparklines.
      const hist = historyRef.current;
      for (const [key, s] of byKey) {
        const arr = hist.get(key) || [];
        arr.push(s.value);
        if (arr.length > HISTORY) arr.shift();
        hist.set(key, arr);
      }
      setMetrics(byKey);
      setError('');
      setUpdatedAt(Date.now());
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(() => document.visibilityState === 'visible' && poll(), POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  const hist = historyRef.current;

  const brokers = useMemo(() => (metrics ? distinctLabel(metrics, 'manifold_broker_topics', 'broker') : []), [metrics]);
  const recordings = useMemo(() => (metrics ? distinctLabel(metrics, 'manifold_recorder_points_total', 'recording') : []), [metrics]);

  // Until the first poll resolves, metrics is null — render a loading/error
  // state instead of falling through to val()/sumBy(), which iterate over it.
  if (!metrics) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="System" subtitle="Manifold's own health and Prometheus readings" />
        <div className="flex-1 p-6">
          {error ? (
            <EmptyState icon={AlertTriangle} title="Couldn't read /metrics" hint={error} />
          ) : (
            <div className="grid h-full place-items-center text-sm text-slate-500">Loading health metrics…</div>
          )}
        </div>
      </div>
    );
  }

  const loopP99 = val(metrics, 'manifold_event_loop_delay_ms', { quantile: '0.99' });
  const loopWarn = loopP99 != null && loopP99 > 100;
  const pipelineErrors = (sumBy(metrics, 'manifold_pipeline_messages_total', 'error') || 0) + (sumBy(metrics, 'manifold_pipeline_messages_total', 'loop_blocked') || 0);
  const dropped = sumBy(metrics, 'manifold_outbox_points_total', 'dropped') || 0;
  const spill = val(metrics, 'manifold_outbox_spill_bytes') || sumBy(metrics, 'manifold_outbox_spill_bytes') || 0;
  const violations = sumBy(metrics, 'manifold_contract_violations_total') || 0;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="System"
        subtitle="Manifold's own health and Prometheus readings — /metrics, live"
        actions={
          <div className="flex items-center gap-3">
            {updatedAt && <span className="text-[11px] text-slate-500">updated {new Date(updatedAt).toLocaleTimeString()}</span>}
            <Button variant="outline" size="sm" onClick={poll}>
              <RefreshCw size={14} /> Refresh
            </Button>
          </div>
        }
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        {error && <p className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">Last poll failed: {error}</p>}

        <Section icon={Activity} title="Process health" warn={loopWarn}>
          <GaugeTile metrics={metrics} hist={hist} name="manifold_process_uptime_seconds" label="Uptime" fmt={fmtUptime} />
          <GaugeTile metrics={metrics} hist={hist} name="manifold_process_memory_bytes" labels={{ kind: 'rss' }} label="Memory RSS" fmt={fmtBytes} />
          <GaugeTile metrics={metrics} hist={hist} name="manifold_process_memory_bytes" labels={{ kind: 'heap_used' }} label="Heap used" fmt={fmtBytes} />
          <GaugeTile
            metrics={metrics}
            hist={hist}
            name="manifold_event_loop_delay_ms"
            labels={{ quantile: '0.99' }}
            label="Event-loop delay p99"
            unit="ms"
            fmt={(v) => fmtNum(v, 1)}
            sub={`p50 ${fmtNum(val(metrics, 'manifold_event_loop_delay_ms', { quantile: '0.5' }), 1)} ms`}
            warn={loopWarn}
          />
        </Section>

        {brokers.length > 0 && (
          <Section icon={Radio} title="Broker ingest">
            {brokers.map((b) => {
              const msgs = histFor(hist, 'manifold_broker_messages_received_total', { broker: b });
              return (
                <StatTile
                  key={b}
                  label={b}
                  value={fmtInt(val(metrics, 'manifold_broker_topics', { broker: b }))}
                  unit="topics"
                  sub={`${fmtInt(rate(msgs) / (POLL_MS / 1000))}/s · ${fmtInt(val(metrics, 'manifold_broker_messages_received_total', { broker: b }))} total`}
                  history={deltas(msgs)}
                />
              );
            })}
          </Section>
        )}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Section icon={Workflow} title="Pipelines" warn={pipelineErrors > 0}>
            {[
              { label: 'Delivered', result: 'delivered' },
              { label: 'Matched', result: 'matched' },
              { label: 'Errors', result: 'error', warnPositive: true },
              { label: 'Loop-blocked', result: 'loop_blocked', warnPositive: true }
            ].map((t) => (
              <CounterTile key={t.result} metrics={metrics} hist={hist} family="manifold_pipeline_messages_total" {...t} />
            ))}
          </Section>

          <Section icon={Database} title="Historian outbox" warn={dropped > 0 || spill > 0}>
            <CounterTile metrics={metrics} hist={hist} family="manifold_outbox_points_total" result="written" label="Written" />
            <GaugeTile metrics={metrics} hist={hist} name="manifold_outbox_queued_points" label="Queued" />
            <StatTile label="Spilled" value={fmtBytes(spill)} warn={spill > 0} history={aggHistory(hist, 'manifold_outbox_spill_bytes')} />
            <CounterTile metrics={metrics} hist={hist} family="manifold_outbox_points_total" result="dropped" label="Dropped" warnPositive />
          </Section>
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Section icon={ShieldCheck} title="Contracts" warn={violations > 0}>
            <CounterTile metrics={metrics} hist={hist} family="manifold_contract_checks_total" label="Checks" />
            <CounterTile metrics={metrics} hist={hist} family="manifold_contract_violations_total" label="Violations" warnPositive />
            <GaugeTile metrics={metrics} hist={hist} name="manifold_alert_events" label="Alert events" />
            <CounterTile metrics={metrics} hist={hist} family="manifold_binding_published_total" label="Bindings published" />
          </Section>

          {recordings.length > 0 && (
            <Section icon={HardDriveDownload} title="Recorder">
              {recordings.map((r) => (
                <StatTile
                  key={r}
                  label={r}
                  value={fmtInt(val(metrics, 'manifold_recorder_points_total', { recording: r }))}
                  unit="points"
                  history={deltas(histFor(hist, 'manifold_recorder_points_total', { recording: r }))}
                />
              ))}
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

// Sum the rolling history across every series of a counter family (optionally a
// result label) so an aggregate tile gets a real trend, not a flat line.
function aggHistory(histMap, name, result) {
  const series = [];
  for (const [key, arr] of histMap) {
    if (!key.startsWith(name)) continue;
    if (result && !key.includes(`result="${result}"`)) continue;
    series.push(arr);
  }
  if (!series.length) return [];
  const len = Math.max(...series.map((a) => a.length));
  const out = new Array(len).fill(0);
  for (const a of series) {
    const offset = len - a.length;
    for (let i = 0; i < a.length; i++) out[offset + i] += a[i];
  }
  return out;
}
