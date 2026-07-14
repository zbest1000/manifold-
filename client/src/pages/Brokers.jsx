import { useState } from 'react';
import { Radio, Plus, Trash2, Server, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import { Card, Button, Badge, Input, Field, EmptyState } from '@/components/ui';
import PageHeader from '@/components/PageHeader';

const BLANK = {
  name: '',
  host: 'localhost',
  port: 1883,
  protocol: 'mqtt',
  username: '',
  password: '',
  // Connection config (advanced)
  clientId: '',
  keepalive: 60,
  timeout: 15000,
  reconnect: true,
  reconnectPeriod: 5000,
  maxReconnect: 0,
  cleanSession: true,
  autoSubscribe: true,
  subscribeQos: 1,
  rejectUnauthorized: true
};

export default function Brokers() {
  const brokers = useStore((s) => s.brokers);
  const openLog = useStore((s) => s.openLog);
  const [form, setForm] = useState(BLANK);
  const [showForm, setShowForm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    if (!form.host) return toast.error('Host is required');
    setBusy(true);
    try {
      await api.connectBroker({
        name: form.name || undefined,
        host: form.host,
        port: Number(form.port),
        protocol: form.protocol,
        username: form.username || undefined,
        password: form.password || undefined,
        clientId: form.clientId || undefined,
        keepalive: Number(form.keepalive) || 60,
        timeout: Number(form.timeout) || 15000,
        reconnect: form.reconnect,
        reconnectPeriod: Number(form.reconnectPeriod) || 5000,
        maxReconnect: Number(form.maxReconnect) || 0,
        cleanSession: form.cleanSession,
        autoSubscribe: form.autoSubscribe,
        subscribeQos: Number(form.subscribeQos),
        rejectUnauthorized: form.rejectUnauthorized
      });
      toast.success('Connecting to broker…');
      setForm(BLANK);
      setShowForm(false);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (id) => {
    try {
      await api.disconnectBroker(id);
      toast.success('Disconnected');
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="MQTT Brokers"
        subtitle="Connect to brokers and stream their topic namespaces"
        actions={
          <Button onClick={() => setShowForm((v) => !v)}>
            <Plus size={15} /> Add broker
          </Button>
        }
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        {showForm && (
          <Card className="p-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Production broker" />
              </Field>
              <Field label="Protocol">
                <select
                  value={form.protocol}
                  onChange={(e) => setForm({ ...form, protocol: e.target.value, port: e.target.value === 'mqtts' ? 8883 : 1883 })}
                  className="w-full rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-100 focus:border-accent-500/60 focus:outline-none"
                >
                  <option value="mqtt">mqtt (TCP)</option>
                  <option value="mqtts">mqtts (TLS)</option>
                </select>
              </Field>
              <Field label="Host">
                <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="broker.example.com" />
              </Field>
              <Field label="Port">
                <Input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              </Field>
              <Field label="Username (optional)">
                <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </Field>
              <Field label="Password (optional)">
                <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </Field>
            </div>

            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="mt-4 flex items-center gap-1.5 text-xs font-medium text-slate-400 transition hover:text-slate-200"
            >
              <ChevronRight size={14} className={clsx('transition-transform', showAdvanced && 'rotate-90')} />
              Connection config — retries, timeouts, keep-alive
            </button>

            {showAdvanced && (
              <div className="mt-3 grid grid-cols-1 gap-4 rounded-xl border border-white/5 bg-surface-950/40 p-4 sm:grid-cols-2">
                <Field label="Client ID (optional)">
                  <Input
                    value={form.clientId}
                    onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                    placeholder="auto-generated"
                  />
                </Field>
                <Field label="Keep-alive (seconds)">
                  <Input type="number" value={form.keepalive} onChange={(e) => setForm({ ...form, keepalive: e.target.value })} />
                </Field>
                <Field label="Connect timeout (ms)">
                  <Input type="number" value={form.timeout} onChange={(e) => setForm({ ...form, timeout: e.target.value })} />
                </Field>
                <Field label="Reconnect delay (ms)">
                  <Input
                    type="number"
                    value={form.reconnectPeriod}
                    disabled={!form.reconnect}
                    onChange={(e) => setForm({ ...form, reconnectPeriod: e.target.value })}
                  />
                </Field>
                <Field label="Subscribe QoS (intake durability)">
                  <select
                    value={form.subscribeQos}
                    onChange={(e) => setForm({ ...form, subscribeQos: e.target.value })}
                    className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200"
                  >
                    <option value={0}>QoS 0 — fire and forget</option>
                    <option value={1}>QoS 1 — at least once (default)</option>
                    <option value={2}>QoS 2 — exactly once</option>
                  </select>
                  <p className="mt-1 text-[11px] leading-snug text-slate-500">
                    If the broker refuses the wildcard grant, intake retries at QoS 0 automatically. Note: stock EMQX
                    <em> silently</em> denies '#' at QoS 1+ (default ACL + deny_action=ignore) — allow it in the broker
                    ACL, or pick QoS 0 here if no data appears.
                  </p>
                </Field>
                <Field label="Max reconnect attempts (0 = unlimited)">
                  <Input
                    type="number"
                    value={form.maxReconnect}
                    disabled={!form.reconnect}
                    onChange={(e) => setForm({ ...form, maxReconnect: e.target.value })}
                  />
                </Field>
                <div className="flex flex-col justify-center gap-2.5">
                  <Check label="Auto-reconnect" checked={form.reconnect} onChange={(v) => setForm({ ...form, reconnect: v })} />
                  <Check label="Clean session" checked={form.cleanSession} onChange={(v) => setForm({ ...form, cleanSession: v })} />
                  <Check label="Auto-subscribe to #" checked={form.autoSubscribe} onChange={(v) => setForm({ ...form, autoSubscribe: v })} />
                  {form.protocol === 'mqtts' && (
                    <Check
                      label="Verify TLS certificate"
                      checked={form.rejectUnauthorized}
                      onChange={(v) => setForm({ ...form, rejectUnauthorized: v })}
                    />
                  )}
                </div>
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
              <Button onClick={connect} disabled={busy}>
                <Radio size={15} /> Connect
              </Button>
            </div>
          </Card>
        )}

        {brokers.length === 0 && !showForm ? (
          <EmptyState
            icon={Server}
            title="No brokers yet"
            hint="Add an MQTT broker connection to begin exploring topics."
            action={<Button onClick={() => setShowForm(true)}>Add broker</Button>}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {brokers.map((b) => (
              <Card key={b.id} className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-sky-400 to-sky-600 shadow-lg">
                      <Radio size={18} className="text-white" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-100">{b.name}</p>
                      <p className="mono text-xs text-slate-500">
                        {b.protocol}://{b.host}:{b.port}
                      </p>
                    </div>
                  </div>
                  <Badge status={b.status} />
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <Metric label="Messages" value={b.metrics?.messagesReceived ?? 0} />
                  <Metric label="Topics" value={b.metrics?.topicCount ?? 0} />
                  <Metric
                    label="Errors"
                    value={b.metrics?.errors ?? 0}
                    onClick={() => openLog(b.id)}
                    valueClassName={(b.metrics?.errors ?? 0) > 0 ? 'text-rose-300' : undefined}
                  />
                </div>
                <div className="mt-4 flex justify-end">
                  <Button variant="danger" size="sm" onClick={() => disconnect(b.id)}>
                    <Trash2 size={13} /> Disconnect
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, onClick, valueClassName }) {
  const clickable = typeof onClick === 'function';
  const Comp = clickable ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      title={clickable ? 'View in log' : undefined}
      className={clsx(
        'w-full rounded-lg bg-white/[0.03] py-2',
        clickable && 'cursor-pointer transition hover:bg-white/[0.08]'
      )}
    >
      <p className={clsx('text-lg font-semibold text-slate-100', valueClassName)}>{value}</p>
      <p className="text-[11px] text-slate-500">{label}</p>
    </Comp>
  );
}

function Check({ label, checked, onChange }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-white/20 bg-surface-950 text-accent-500 focus:ring-2 focus:ring-accent-500/40"
      />
      {label}
    </label>
  );
}
