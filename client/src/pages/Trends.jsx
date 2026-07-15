import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, X, Plus, Database, TrendingUp } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import PageHeader from '@/components/PageHeader';
import TrendChart, { seriesColor } from '@/components/TrendChart';
import { Card, Button, Input, Field, EmptyState } from '@/components/ui';

/**
 * Trends — read-back for the historians pipelines and the recorder write into.
 * Pick a historian, add up to MAX_TAGS stored topics (searched from the
 * historian itself, or typed free-text), pick a window, get a chart.
 */

const MAX_TAGS = 10;

const RANGE_PRESETS = [
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h', ms: 3_600_000 },
  { label: '6h', ms: 6 * 3_600_000 },
  { label: '24h', ms: 24 * 3_600_000 },
  { label: '7d', ms: 7 * 24 * 3_600_000 }
];

const AUTO_REFRESH_MS = 30_000;

export default function Trends() {
  const [historians, setHistorians] = useState([]);
  const [histId, setHistId] = useState('');
  const [tags, setTags] = useState([]);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [rangeMs, setRangeMs] = useState(3_600_000);
  const [data, setData] = useState(null); // { series, start, end }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const searchSeq = useRef(0);

  useEffect(() => {
    api
      .listHistorians()
      .then((r) => {
        setHistorians(r.historians);
        // Prefer a historian with tag search (timebase queries fine but has
        // no tag-listing API, so it's a worse default).
        const first = r.historians.find((h) => h.type !== 'timebase') || r.historians[0];
        if (first) setHistId((prev) => prev || first.id);
      })
      .catch(() => {});
  }, []);

  const selected = useMemo(() => historians.find((h) => h.id === histId) || null, [historians, histId]);
  const searchable = selected && selected.type !== 'timebase'; // timebase: no tag-listing API

  // Debounced tag search against the historian itself.
  useEffect(() => {
    if (!histId || !searchable) {
      setSuggestions([]);
      return;
    }
    const seq = ++searchSeq.current;
    const t = setTimeout(() => {
      api
        .historianTags(histId, query, 25)
        .then((r) => {
          if (seq === searchSeq.current) setSuggestions(r.tags || []);
        })
        .catch(() => {
          if (seq === searchSeq.current) setSuggestions([]);
        });
    }, 300);
    return () => clearTimeout(t);
  }, [histId, query, searchable]);

  const addTag = (raw) => {
    const tag = String(raw || '').trim();
    if (!tag) return;
    setTags((prev) => (prev.includes(tag) || prev.length >= MAX_TAGS ? prev : [...prev, tag]));
    setQuery('');
    setSuggestOpen(false);
  };

  const removeTag = (tag) => setTags((prev) => prev.filter((t) => t !== tag));

  const load = useCallback(() => {
    if (!histId || tags.length === 0) {
      setData(null);
      setError('');
      return;
    }
    const end = Date.now();
    const start = end - rangeMs;
    setLoading(true);
    api
      .historianQuery(histId, {
        tags,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        maxPoints: 1000
      })
      .then((r) => {
        setData({ series: r.series || [], start, end });
        setError('');
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [histId, tags, rangeMs]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh: 30s cadence, skipped while the tab is hidden.
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  const shownSuggestions = suggestions.filter((s) => !tags.includes(s));

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Trends"
        subtitle="chart what your pipelines wrote into a historian"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant={autoRefresh ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setAutoRefresh((v) => !v)}
              title="Re-query every 30s while this page is visible"
            >
              Auto 30s
            </Button>
            <Button variant="outline" size="sm" onClick={load} disabled={!histId || tags.length === 0}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
            </Button>
          </div>
        }
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        {historians.length === 0 ? (
          <EmptyState
            icon={Database}
            title="No historians configured"
            hint="Trends reads back what Manifold wrote. Add an InfluxDB or TimescaleDB historian under Pipelines → Historians first."
          />
        ) : (
          <>
            <Card className="p-4">
              <div className="grid gap-4 md:grid-cols-[240px_1fr_auto]">
                <Field label="Historian">
                  <select
                    value={histId}
                    onChange={(e) => {
                      setHistId(e.target.value);
                      setSuggestions([]);
                    }}
                    className="w-full rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-100 focus:border-accent-500/60 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
                  >
                    {historians.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name || h.id.slice(0, 8)} ({h.type})
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label={`Tags (${tags.length}/${MAX_TAGS})`}>
                  <div className="relative">
                    <div className="flex gap-2">
                      <Input
                        value={query}
                        placeholder={searchable ? 'Search stored topics… or type a path and press Enter' : 'Type the tag path and press Enter'}
                        disabled={tags.length >= MAX_TAGS}
                        onChange={(e) => {
                          setQuery(e.target.value);
                          setSuggestOpen(true);
                        }}
                        onFocus={() => setSuggestOpen(true)}
                        onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addTag(query);
                          }
                          if (e.key === 'Escape') setSuggestOpen(false);
                        }}
                      />
                      <Button variant="subtle" size="sm" onClick={() => addTag(query)} disabled={!query.trim() || tags.length >= MAX_TAGS}>
                        <Plus size={14} /> Add
                      </Button>
                    </div>
                    {suggestOpen && searchable && shownSuggestions.length > 0 && (
                      <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-white/10 bg-surface-900/95 py-1 shadow-2xl backdrop-blur">
                        {shownSuggestions.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              addTag(s);
                            }}
                            className="block w-full truncate px-3 py-1.5 text-left text-xs text-slate-300 hover:bg-white/5 hover:text-white"
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </Field>

                <Field label="Range">
                  <div className="flex overflow-hidden rounded-xl border border-white/10">
                    {RANGE_PRESETS.map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => setRangeMs(p.ms)}
                        className={clsx(
                          'px-3 py-2 text-xs font-medium transition',
                          rangeMs === p.ms ? 'bg-accent-500/20 text-accent-300' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                        )}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>

              {tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {tags.map((tag, i) => (
                    <span
                      key={tag}
                      className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 py-0.5 pl-2.5 pr-1 text-xs text-slate-200"
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: seriesColor(i) }} />
                      <span className="max-w-[240px] truncate">{tag}</span>
                      <button
                        type="button"
                        onClick={() => removeTag(tag)}
                        className="rounded-full p-0.5 text-slate-500 transition hover:bg-white/10 hover:text-white"
                        title="Remove tag"
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {selected?.type === 'timebase' && (
                <p className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                  Timebase has no tag-listing API, so search is off — type the exact tag path and press Enter. Querying
                  works normally.
                </p>
              )}
            </Card>

            <Card className="p-4">
              {tags.length === 0 && !error ? (
                <div className="grid place-items-center" style={{ height: 380 }}>
                  <EmptyState
                    icon={TrendingUp}
                    title="Nothing to trend yet"
                    hint="Add up to ten stored topics above — search pulls names straight from the historian, or type a path and press Enter."
                  />
                </div>
              ) : (
                <TrendChart
                  series={data?.series || []}
                  start={data?.start}
                  end={data?.end}
                  loading={loading}
                  error={error}
                  height={380}
                />
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
