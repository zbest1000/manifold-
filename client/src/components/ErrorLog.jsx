import { motion, AnimatePresence } from 'framer-motion';
import { ScrollText, X, Trash2, Inbox, Filter } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '@/store/store';
import { Tooltip } from './ui';

const LEVELS = ['error', 'warning', 'info', 'verbose'];
const LEVEL_STYLE = {
  error: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  warning: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  info: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  verbose: 'bg-slate-500/15 text-slate-300 ring-slate-500/30'
};

function relTime(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function Empty({ title, hint }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-slate-500">
      <Inbox size={26} className="text-slate-600" />
      <p className="text-sm">{title}</p>
      <p className="max-w-xs text-xs text-slate-600">{hint}</p>
    </div>
  );
}

/** Persistent, leveled, filterable log. Opened from the sidebar or from a
 *  broker's error count (scoped to that broker). Open state lives in the store. */
export default function ErrorLog({ collapsed = false }) {
  const logs = useStore((s) => s.logs);
  const unseen = useStore((s) => s.unseen);
  const logFilters = useStore((s) => s.logFilters);
  const logOpen = useStore((s) => s.logOpen);
  const logBrokerFilter = useStore((s) => s.logBrokerFilter);
  const brokers = useStore((s) => s.brokers);
  const openLog = useStore((s) => s.openLog);
  const closeLog = useStore((s) => s.closeLog);
  const clearLogs = useStore((s) => s.clearLogs);
  const clearBrokerFilter = useStore((s) => s.clearBrokerFilter);
  const toggleLogFilter = useStore((s) => s.toggleLogFilter);

  const counts = LEVELS.reduce((acc, lv) => ({ ...acc, [lv]: 0 }), {});
  for (const l of logs) counts[l.level] = (counts[l.level] || 0) + 1;

  const visible = logs.filter(
    (l) => logFilters[l.level] && (!logBrokerFilter || l.meta?.brokerId === logBrokerFilter)
  );
  const filterBrokerName = logBrokerFilter
    ? brokers.find((b) => b.id === logBrokerFilter)?.name || logBrokerFilter
    : null;

  const badge = unseen > 0 ? unseen : logs.length;

  return (
    <>
      {collapsed ? (
        <Tooltip label={unseen > 0 ? `Log — ${unseen} new` : 'Event log'} side="right">
          <button
            onClick={() => openLog()}
            aria-label="View the event log"
            className={clsx(
              'relative grid h-8 w-8 place-items-center rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60',
              unseen > 0 ? 'bg-rose-500/15 text-rose-300' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            )}
          >
            <ScrollText size={16} />
            {unseen > 0 && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-surface-900" />}
          </button>
        </Tooltip>
      ) : (
        <button
          onClick={() => openLog()}
          title="View the event log (errors, warnings, info, verbose)"
          className={clsx(
            'flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60',
            unseen > 0
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15'
              : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/5'
          )}
        >
          <span className="flex items-center gap-2 text-sm">
            <ScrollText size={14} />
            Logs
          </span>
          <span
            className={clsx(
              'mono rounded-full px-1.5 py-0.5 text-2xs font-semibold',
              unseen > 0 ? 'bg-rose-500 text-white' : 'bg-white/10 text-slate-400'
            )}
          >
            {badge}
          </span>
        </button>
      )}

      <AnimatePresence>
        {logOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeLog}
            />
            <motion.aside
              className="fixed right-0 top-0 z-50 flex h-screen w-full max-w-md flex-col border-l border-white/10 bg-surface-900 shadow-2xl"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'tween', duration: 0.2 }}
              role="dialog"
              aria-label="Log"
            >
              <header className="flex items-center justify-between border-b border-white/5 px-4 py-3">
                <div className="flex items-center gap-2">
                  <ScrollText size={16} className="text-slate-300" />
                  <h2 className="text-sm font-semibold text-slate-100">Log</h2>
                  <span className="mono text-xs text-slate-500">{logs.length}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={clearLogs}
                    disabled={logs.length === 0}
                    className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-slate-400 transition hover:bg-white/5 hover:text-slate-200 disabled:opacity-40"
                  >
                    <Trash2 size={13} /> Clear
                  </button>
                  <button
                    onClick={closeLog}
                    className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
                    aria-label="Close log"
                  >
                    <X size={16} />
                  </button>
                </div>
              </header>

              {/* Broker scope (set when opened from a broker's error count) */}
              {logBrokerFilter && (
                <div className="flex items-center gap-2 border-b border-white/5 bg-white/[0.02] px-4 py-2 text-xs text-slate-300">
                  <Filter size={12} className="text-slate-500" />
                  <span>
                    Filtered to <span className="font-medium text-slate-100">{filterBrokerName}</span>
                  </span>
                  <button
                    onClick={clearBrokerFilter}
                    className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
                  >
                    <X size={11} /> clear
                  </button>
                </div>
              )}

              {/* Level filter — persisted. Click a level to show/hide it. */}
              <div className="flex flex-wrap gap-1.5 border-b border-white/5 px-4 py-2.5">
                {LEVELS.map((lv) => (
                  <button
                    key={lv}
                    onClick={() => toggleLogFilter(lv)}
                    aria-pressed={logFilters[lv]}
                    className={clsx(
                      'rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide ring-1 ring-inset transition',
                      logFilters[lv] ? LEVEL_STYLE[lv] : 'bg-transparent text-slate-600 ring-white/10 hover:text-slate-400'
                    )}
                  >
                    {lv} <span className="mono ml-0.5 opacity-70">{counts[lv]}</span>
                  </button>
                ))}
              </div>

              <div className="flex-1 overflow-y-auto">
                {logs.length === 0 ? (
                  <Empty
                    title="No activity logged"
                    hint="Failures, connections, and subscribe/publish events show up here."
                  />
                ) : visible.length === 0 ? (
                  <Empty
                    title="Nothing matches"
                    hint={logBrokerFilter ? 'No entries for this broker at the enabled levels.' : 'Enable a level above to see entries.'}
                  />
                ) : (
                  <ul className="divide-y divide-white/5">
                    {visible.map((e) => (
                      <li key={e.id} className="px-4 py-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span
                              className={clsx(
                                'rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset',
                                LEVEL_STYLE[e.level] || LEVEL_STYLE.verbose
                              )}
                            >
                              {e.level}
                            </span>
                            <span className="mono text-[10px] uppercase text-slate-500">{e.source}</span>
                            {e.meta?.code && (
                              <span className="mono rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-300 ring-1 ring-inset ring-white/10">
                                {e.meta.code}
                              </span>
                            )}
                            {e.count > 1 && (
                              <span className="mono rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">
                                ×{e.count}
                              </span>
                            )}
                          </span>
                          <span className="mono shrink-0 text-[11px] text-slate-500">{relTime(e.ts)}</span>
                        </div>
                        <p className="mt-1 break-words text-sm text-slate-200">{e.message}</p>
                        {e.meta?.hint && <p className="mt-0.5 text-xs text-slate-400">{e.meta.hint}</p>}
                        {(e.meta?.topic || e.meta?.path) && (
                          <p className="mono mt-1 truncate text-[11px] text-slate-500">
                            {e.meta.path || e.meta.topic}
                          </p>
                        )}
                        {e.meta?.raw && e.meta.raw !== e.message && (
                          <p className="mono mt-1 break-all text-[11px] text-slate-600" title={e.meta.raw}>
                            {e.meta.raw}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
