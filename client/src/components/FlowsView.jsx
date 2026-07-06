import { useState } from 'react';
import { Radio, Users } from 'lucide-react';
import clsx from 'clsx';
import ProducerFlows from '@/components/ProducerFlows';
import ConsumerFlows from '@/components/ConsumerFlows';

/**
 * Flows workspace: live visibility into the producer → topic → consumer fabric.
 *  - Producers: who publishes what — Sparkplug B device topology + $SYS health
 *    (from observed traffic; needs no broker cooperation).
 *  - Consumers: who receives what — per-client subscriptions from a broker admin
 *    API, with every wildcard filter RESOLVED against the observed topic set so
 *    a broad filter like `spBv1.0/#` shows the concrete topics it covers.
 */
export default function FlowsView({ broker }) {
  const [tab, setTab] = useState('producers');
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-1 border-b border-white/5 px-3 py-2">
        <SubTab active={tab === 'producers'} onClick={() => setTab('producers')} icon={Radio} label="Producers" hint="who publishes what (Sparkplug + $SYS)" />
        <SubTab active={tab === 'consumers'} onClick={() => setTab('consumers')} icon={Users} label="Consumers" hint="who receives what (admin API, wildcards resolved)" />
      </div>
      <div className="min-h-0 flex-1">{tab === 'producers' ? <ProducerFlows broker={broker} /> : <ConsumerFlows broker={broker} />}</div>
    </div>
  );
}

function SubTab({ active, onClick, icon: Icon, label, hint }) {
  return (
    <button
      onClick={onClick}
      title={hint}
      className={clsx(
        'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition',
        active ? 'bg-accent-500/15 text-accent-200' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
      )}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}
