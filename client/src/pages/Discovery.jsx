import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radar, Play, Square, Radio, Cpu, Plug, Boxes } from 'lucide-react';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import { Card, Button, Badge, Input, Field } from '@/components/ui';
import PageHeader from '@/components/PageHeader';

export default function Discovery() {
  const discovery = useStore((s) => s.discovery);
  const navigate = useNavigate();
  const [range, setRange] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      await api.startDiscovery(range ? { range } : {});
      toast.success('Scan started');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    try {
      await api.stopDiscovery();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const connectResult = async (r) => {
    try {
      if (r.kind === 'mqtt') {
        await api.connectBroker({ host: r.host, port: r.port, protocol: r.port === 8883 ? 'mqtts' : 'mqtt' });
        toast.success(`Connecting to ${r.host}:${r.port}`);
      } else if (r.kind === 'opcua') {
        await api.connectOpcua({ endpointUrl: r.endpointUrl || `opc.tcp://${r.host}:${r.port}` });
        toast.success(`Connecting to ${r.host}:${r.port}`);
      } else if (r.kind === 'i3x') {
        await api.i3xConnect({ baseUrl: r.baseUrl });
        toast.success(`Connected to i3X at ${r.baseUrl}`);
        navigate('/i3x');
      }
    } catch (e) {
      toast.error(e.message);
    }
  };

  const kindMeta = {
    mqtt: { icon: Radio, cls: 'bg-sky-500/20 text-sky-300' },
    opcua: { icon: Cpu, cls: 'bg-violet-500/20 text-violet-300' },
    i3x: { icon: Boxes, cls: 'bg-teal-500/20 text-teal-300' }
  };

  const { progress, results, scanning } = discovery;
  const pct = progress && progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Network Discovery"
        subtitle="Probe your network for MQTT brokers, OPC UA servers, and i3X endpoints"
        actions={
          scanning ? (
            <Button variant="danger" onClick={stop}>
              <Square size={15} /> Stop scan
            </Button>
          ) : (
            <Button onClick={start} disabled={busy}>
              <Play size={15} /> Start scan
            </Button>
          )
        }
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        <Card className="p-5">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Field label="CIDR range (blank = auto-detect local subnet)">
                <Input value={range} onChange={(e) => setRange(e.target.value)} placeholder="192.168.1.0/24" />
              </Field>
            </div>
            {!scanning && (
              <Button onClick={start} disabled={busy}>
                <Radar size={15} /> Scan
              </Button>
            )}
          </div>

          {scanning && (
            <div className="mt-4">
              <div className="mb-1.5 flex justify-between text-xs text-slate-400">
                <span>Scanning… {progress?.found || 0} found</span>
                <span>{pct}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/5">
                <div className="h-full rounded-full bg-gradient-to-r from-accent-400 to-accent-600 transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}
        </Card>

        <div>
          <p className="mb-3 text-sm font-semibold text-slate-300">
            Results {results.length > 0 && <span className="text-slate-500">({results.length})</span>}
          </p>
          {results.length === 0 ? (
            <Card className="p-10 text-center">
              <Radar size={28} className="mx-auto text-slate-600" />
              <p className="mt-3 text-sm text-slate-500">
                {scanning ? 'Probing hosts…' : 'No results yet. Start a scan to find endpoints on your network.'}
              </p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {results.map((r) => {
                const meta = kindMeta[r.kind] || kindMeta.mqtt;
                const Icon = meta.icon;
                return (
                <Card key={`${r.host}:${r.port}`} className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`grid h-10 w-10 place-items-center rounded-xl ${meta.cls}`}>
                        <Icon size={18} />
                      </div>
                      <div>
                        <p className="mono text-sm font-medium text-slate-100">
                          {r.host}:{r.port}
                        </p>
                        <p className="text-xs uppercase tracking-wide text-slate-500">
                          {r.kind === 'i3x' ? 'i3X' : r.kind}
                        </p>
                      </div>
                    </div>
                    {r.verified ? (
                      <Badge status="connected">verified</Badge>
                    ) : (
                      <Badge>open port</Badge>
                    )}
                  </div>
                  {r.kind === 'mqtt' && r.verified && (
                    <p className="mt-2 text-xs text-slate-500">
                      {r.anonymousAccess ? 'Anonymous access allowed' : 'Authentication required'}
                    </p>
                  )}
                  {r.kind === 'i3x' && (
                    <p className="mono mt-2 truncate text-xs text-slate-500">
                      {r.serverName ? `${r.serverName} · ` : ''}{r.baseUrl}
                    </p>
                  )}
                  <div className="mt-3 flex justify-end">
                    <Button size="sm" variant="subtle" onClick={() => connectResult(r)}>
                      <Plug size={13} /> Connect
                    </Button>
                  </div>
                </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
