import { useEffect, useMemo, useState } from 'react';
import { Factory, Plug, LogOut, Search, LineChart, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { Card, Button, Badge, Input, Field, EmptyState } from '@/components/ui';
import { Sparkline as ChartSparkline, fmtNum } from '@/components/charts';
import PageHeader from '@/components/PageHeader';

const BLANK = { endpoint: '', authenticator: '', role: '', userName: '', secret: '' };

const pad2 = (n) => String(n).padStart(2, '0');

// datetime-local wants a LOCAL "YYYY-MM-DDTHH:MM"; build one for now minus `days`.
function localValue(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Convert a datetime-local value (local time) to the SMIP UTC form the API wants
// ("2026-07-10 00:00:00+00"). Everything crosses the wire in UTC (see TIMEZONE).
function localToSmip(local) {
  const ms = Date.parse(local);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ') + '+00';
}

const RANGE_PRESETS = [
  { label: '1h', days: 1 / 24 },
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 }
];

export default function Cesmii() {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [equipment, setEquipment] = useState([]);
  const [attributes, setAttributes] = useState([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [samples, setSamples] = useState(null);
  const [range, setRange] = useState({ start: localValue(7), end: localValue(0), maxSamples: 100 });

  const refreshStatus = () => api.cesmiiStatus().then(setStatus).catch(() => {});

  useEffect(() => {
    refreshStatus();
  }, []);

  const connected = status?.configured && status?.authenticated;

  useEffect(() => {
    if (!connected) return;
    api.cesmiiEquipment().then((r) => setEquipment(r.equipment)).catch((e) => toast.error(e.message));
    api.cesmiiAttributes().then((r) => setAttributes(r.attributes)).catch((e) => toast.error(e.message));
  }, [connected]);

  const connect = async () => {
    setBusy(true);
    try {
      const s = await api.cesmiiConfig(form);
      setStatus(s);
      toast.success('Connected to CESMII SMIP');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    try {
      setStatus(await api.cesmiiReset());
      setEquipment([]);
      setAttributes([]);
      setSelected(null);
      setSamples(null);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const loadHistory = async (attr) => {
    setSelected(attr);
    setSamples(null);
    try {
      const r = await api.cesmiiHistory({
        ids: [attr.id],
        startTime: localToSmip(range.start),
        endTime: localToSmip(range.end),
        maxSamples: range.maxSamples
      });
      setSamples(r.samples);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const filteredAttributes = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return attributes;
    return attributes.filter((a) => a.displayName?.toLowerCase().includes(q) || String(a.id).includes(q));
  }, [attributes, filter]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="CESMII SMIP"
        subtitle="Query equipment, attributes and time-series from the Smart Manufacturing Innovation Platform"
        actions={
          connected ? (
            <div className="flex items-center gap-2">
              <Badge status="connected">authenticated</Badge>
              <Button variant="outline" onClick={disconnect}>
                <LogOut size={15} /> Disconnect
              </Button>
            </div>
          ) : (
            <Badge>not connected</Badge>
          )
        }
      />

      <div className="flex-1 overflow-y-auto p-6">
        {!connected ? (
          <div className="mx-auto max-w-2xl">
            <Card className="p-6">
              <div className="mb-4 flex items-center gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-orange-400 to-amber-600 shadow-lg">
                  <Factory size={20} className="text-white" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-slate-100">Connect a SMIP instance</h2>
                  <p className="text-xs text-slate-500">Credentials are used server-side for the JWT handshake and are not stored on disk.</p>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Field label="GraphQL endpoint">
                    <Input value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} placeholder="https://demo.cesmii.net/graphql" />
                  </Field>
                </div>
                <Field label="Authenticator">
                  <Input value={form.authenticator} onChange={(e) => setForm({ ...form, authenticator: e.target.value })} />
                </Field>
                <Field label="Role">
                  <Input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} />
                </Field>
                <Field label="User name">
                  <Input value={form.userName} onChange={(e) => setForm({ ...form, userName: e.target.value })} />
                </Field>
                <Field label="Secret / API key">
                  <Input type="password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
                </Field>
              </div>
              <div className="mt-5 flex justify-end">
                <Button onClick={connect} disabled={busy || !form.endpoint}>
                  <Plug size={15} /> {busy ? 'Authenticating…' : 'Connect'}
                </Button>
              </div>
            </Card>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-200">Equipment ({equipment.length})</h2>
              </div>
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {equipment.length === 0 ? (
                  <p className="py-6 text-center text-xs text-slate-500">No equipment returned.</p>
                ) : (
                  equipment.map((e) => (
                    <div key={e.id} className="flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                      <span className="truncate text-sm text-slate-200">{e.displayName}</span>
                      <span className="mono text-[11px] text-slate-500">#{e.id}</span>
                    </div>
                  ))
                )}
              </div>
            </Card>

            <Card className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <Search size={15} className="text-slate-500" />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={`Filter ${attributes.length} attributes…`}
                  className="w-full bg-transparent text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none"
                />
              </div>
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {filteredAttributes.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => loadHistory(a)}
                    className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition ${
                      selected?.id === a.id
                        ? 'border-accent-500/60 bg-accent-500/10'
                        : 'border-white/5 bg-white/[0.02] hover:border-white/15'
                    }`}
                  >
                    <span className="truncate text-sm text-slate-200">{a.displayName}</span>
                    <LineChart size={13} className="shrink-0 text-slate-500" />
                  </button>
                ))}
              </div>
            </Card>

            <Card className="p-4">
              <h2 className="mb-3 text-sm font-semibold text-slate-200">
                {selected ? selected.displayName : 'Time series'}
              </h2>
              <div className="mb-3 grid grid-cols-1 gap-2">
                <div className="flex flex-wrap gap-1.5">
                  {RANGE_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setRange((r) => ({ ...r, start: localValue(p.days), end: localValue(0) }))}
                      className="rounded-lg border border-white/10 px-2.5 py-1 text-xs font-medium text-slate-400 transition hover:border-white/25 hover:text-slate-200"
                    >
                      Last {p.label}
                    </button>
                  ))}
                </div>
                <Field label="Start">
                  <Input type="datetime-local" value={range.start} onChange={(e) => setRange({ ...range, start: e.target.value })} />
                </Field>
                <Field label="End">
                  <Input type="datetime-local" value={range.end} onChange={(e) => setRange({ ...range, end: e.target.value })} />
                </Field>
                <Field label="Max samples">
                  <Input
                    type="number"
                    min="1"
                    max="5000"
                    value={range.maxSamples}
                    onChange={(e) => setRange({ ...range, maxSamples: Number(e.target.value) || 100 })}
                  />
                </Field>
                {selected && (
                  <Button size="sm" variant="subtle" onClick={() => loadHistory(selected)}>
                    <RefreshCw size={13} /> Reload
                  </Button>
                )}
              </div>

              {!selected ? (
                <EmptyState icon={LineChart} title="Pick an attribute" hint="Select an attribute to load its history." />
              ) : samples === null ? (
                <p className="py-6 text-center text-xs text-slate-500">Loading…</p>
              ) : samples.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-500">No samples in this range.</p>
              ) : (
                <>
                  <Sparkline samples={samples} />
                  <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                    {samples.slice(-40).reverse().map((s, i) => (
                      <div key={i} className="flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-white/5">
                        <span className="text-slate-500">{s.ts}</span>
                        <span className="mono text-slate-200">{s.floatvalue ?? s.stringvalue}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function Sparkline({ samples }) {
  const values = samples.map((s) => Number(s.floatvalue)).filter((v) => Number.isFinite(v));
  if (values.length < 2) return null;
  return (
    <div className="rounded-lg border border-white/5 bg-surface-950/50 p-2">
      <ChartSparkline values={values} height={64} />
      <div className="mono mt-1 flex justify-between text-2xs text-slate-500">
        <span>min {fmtNum(Math.min(...values))}</span>
        <span>max {fmtNum(Math.max(...values))}</span>
      </div>
    </div>
  );
}
