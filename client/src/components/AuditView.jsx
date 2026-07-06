import { useState } from 'react';
import { Radio, Users } from 'lucide-react';
import clsx from 'clsx';
import SparkplugAudit from '@/components/SparkplugAudit';
import SubscriberAudit from '@/components/SubscriberAudit';

/**
 * Audit workspace. Two honest lenses on a broker:
 *  - Publishers: Sparkplug B device topology + $SYS health (observed traffic).
 *  - Subscribers: per-client subscription map from a broker admin API (EMQX).
 */
export default function AuditView({ broker }) {
  const [tab, setTab] = useState('publishers');
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-1 border-b border-white/5 px-3 py-2">
        <SubTab active={tab === 'publishers'} onClick={() => setTab('publishers')} icon={Radio} label="Publishers" hint="Sparkplug devices + $SYS" />
        <SubTab active={tab === 'subscribers'} onClick={() => setTab('subscribers')} icon={Users} label="Subscribers" hint="who subscribes (admin API)" />
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'publishers' ? <SparkplugAudit broker={broker} /> : <SubscriberAudit broker={broker} />}
      </div>
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
