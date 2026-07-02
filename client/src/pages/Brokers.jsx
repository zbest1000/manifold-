import { useState } from 'react';
import { Radio, Plus, Trash2, Server } from 'lucide-react';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import { Card, Button, Badge, Input, Field, EmptyState } from '@/components/ui';
import PageHeader from '@/components/PageHeader';

const BLANK = { name: '', host: 'localhost', port: 1883, protocol: 'mqtt', username: '', password: '' };

export default function Brokers() {
  const brokers = useStore((s) => s.brokers);
  const [form, setForm] = useState(BLANK);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    if (!form.host) return toast.error('Host is required');
    setBusy(true);
    try {
      await api.connectBroker({
        ...form,
        port: Number(form.port),
        username: form.username || undefined,
        password: form.password || undefined
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
                  <Metric label="Errors" value={b.metrics?.errors ?? 0} />
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

function Metric({ label, value }) {
  return (
    <div className="rounded-lg bg-white/[0.03] py-2">
      <p className="text-lg font-semibold text-slate-100">{value}</p>
      <p className="text-[11px] text-slate-500">{label}</p>
    </div>
  );
}
