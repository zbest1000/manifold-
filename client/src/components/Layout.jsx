import { NavLink, Outlet } from 'react-router-dom';
import { Share2, Radio, Cpu, Radar, Settings as SettingsIcon, Activity, Factory, Boxes, Waypoints, Network, Workflow } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '@/store/store';
import { StatusDot } from './ui';
import ErrorLog from './ErrorLog';

// Task-shaped nav: explore (Topics), audit (Flows), then per-protocol sources.
// Flows is top-level — producer → topic → consumer visibility is a primary job
// of the tool, not a sub-tab. (The old "Unified" overlay page is retired; its
// job is better served by Topics + Flows.)
const NAV = [
  { to: '/', label: 'Overview', icon: Activity, end: true },
  { to: '/topics', label: 'Topics', icon: Share2 },
  { to: '/uns', label: 'UNS', icon: Network },
  { to: '/flows', label: 'Flows', icon: Waypoints },
  { to: '/pipelines', label: 'Pipelines', icon: Workflow },
  { to: '/brokers', label: 'MQTT Brokers', icon: Radio },
  { to: '/opcua', label: 'OPC UA', icon: Cpu },
  { to: '/cesmii', label: 'CESMII SMIP', icon: Factory },
  { to: '/i3x', label: 'i3X', icon: Boxes },
  { to: '/discovery', label: 'Discovery', icon: Radar },
  { to: '/settings', label: 'Settings', icon: SettingsIcon }
];

export default function Layout() {
  const connected = useStore((s) => s.connected);
  const brokers = useStore((s) => s.brokers);
  const opcua = useStore((s) => s.opcua);

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

        <nav className="flex-1 space-y-1 px-3 py-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition',
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

      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
