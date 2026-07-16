import { NavLink, Outlet } from 'react-router-dom';
import { Share2, Radio, Cpu, Radar, Settings as SettingsIcon, Activity, Factory, Boxes, Waypoints, Network, Workflow, Tags as TagsIcon, LineChart, Lock } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '@/store/store';
import { StatusDot } from './ui';
import ErrorLog from './ErrorLog';

// The nav outgrew a flat list — group by the job the user is doing:
// OBSERVE the estate, BUILD on the stream, CONNECT sources, run the SYSTEM.
const NAV_GROUPS = [
  {
    label: null, // top-level, no caption
    items: [{ to: '/', label: 'Overview', icon: Activity, end: true }]
  },
  {
    label: 'Observe',
    items: [
      { to: '/topics', label: 'Topics', icon: Share2 },
      { to: '/uns', label: 'UNS', icon: Network },
      { to: '/flows', label: 'Flows', icon: Waypoints },
      { to: '/trends', label: 'Trends', icon: LineChart }
    ]
  },
  {
    label: 'Build',
    items: [
      { to: '/pipelines', label: 'Pipelines', icon: Workflow },
      { to: '/tags', label: 'Tags', icon: TagsIcon }
    ]
  },
  {
    label: 'Connect',
    items: [
      { to: '/brokers', label: 'MQTT Brokers', icon: Radio },
      { to: '/opcua', label: 'OPC UA', icon: Cpu },
      { to: '/cesmii', label: 'CESMII SMIP', icon: Factory },
      { to: '/i3x', label: 'i3X', icon: Boxes },
      { to: '/discovery', label: 'Discovery', icon: Radar }
    ]
  },
  {
    label: 'System',
    items: [{ to: '/settings', label: 'Settings', icon: SettingsIcon }]
  }
];

export default function Layout() {
  const connected = useStore((s) => s.connected);
  const brokers = useStore((s) => s.brokers);
  const opcua = useStore((s) => s.opcua);
  const viewerReadOnly = useStore((s) => s.authRole === 'viewer');

  return (
    <div className="flex h-screen bg-surface-950 text-slate-100">
      <aside className="flex w-60 flex-col border-r border-white/5 bg-surface-900/50">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-accent-400 to-accent-600 shadow-lg shadow-accent-500/30">
            <Share2 size={18} className="text-white" />
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">Manifold</p>
            <p className="text-[11px] text-slate-500">UNS · MQTT · OPC UA</p>
          </div>
        </div>

        {viewerReadOnly && (
          <div
            className="mx-5 mb-2 flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-medium text-amber-300"
            title="This token is read-only — changes will be rejected by the server."
          >
            <Lock size={12} /> Read-only session
          </div>
        )}

        <nav className="flex-1 overflow-y-auto px-3 py-1">
          {NAV_GROUPS.map((group, gi) => (
            <div key={group.label || gi} className={gi > 0 ? 'mt-3' : ''}>
              {group.label && (
                <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-600">
                  {group.label}
                </p>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      clsx(
                        'flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition',
                        isActive
                          ? 'bg-accent-500/15 text-accent-300 ring-1 ring-inset ring-accent-500/25'
                          : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                      )
                    }
                  >
                    <item.icon size={17} />
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="space-y-2 border-t border-white/5 px-4 py-4 text-xs">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-slate-400">
              <StatusDot status={connected ? 'connected' : 'disconnected'} />
              {connected ? 'Live' : 'Offline'}
            </span>
          </div>
          <div className="flex items-center justify-between text-slate-500">
            <span>Brokers</span>
            <span className="mono text-slate-300">{brokers.length}</span>
          </div>
          <div className="flex items-center justify-between text-slate-500">
            <span>OPC UA</span>
            <span className="mono text-slate-300">{opcua.length}</span>
          </div>
          <div className="pt-1">
            <ErrorLog />
          </div>
        </div>
      </aside>

      <main className="relative flex-1 overflow-hidden">
        {!connected && (
          // Global disconnect banner: every panel silently shows stale data
          // while the socket is down, so the whole workspace says so loudly.
          <div
            role="alert"
            className="absolute inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-rose-600/90 px-4 py-1.5 text-xs font-medium text-white shadow-lg"
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
            Connection to the Manifold server lost — live data is stale. Reconnecting…
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
