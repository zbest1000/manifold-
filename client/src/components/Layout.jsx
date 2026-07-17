import { useEffect } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Share2, Radio, Cpu, Radar, Settings as SettingsIcon, Activity, Factory, Boxes, Waypoints, Network, Workflow, Tags as TagsIcon, LineChart, Lock, Gauge, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '@/store/store';
import { StatusDot, Tooltip, IconButton } from './ui';
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
    items: [
      { to: '/system', label: 'Health', icon: Gauge },
      { to: '/settings', label: 'Settings', icon: SettingsIcon }
    ]
  }
];

export default function Layout() {
  const connected = useStore((s) => s.connected);
  const brokers = useStore((s) => s.brokers);
  const opcua = useStore((s) => s.opcua);
  const viewerReadOnly = useStore((s) => s.authRole === 'viewer');
  const collapsed = useStore((s) => s.navCollapsed);
  const toggleNav = useStore((s) => s.toggleNav);

  // Keyboard shortcut: `[` toggles the sidebar (ignored while typing).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      toggleNav();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleNav]);

  return (
    <div className="flex h-screen bg-surface-950 text-slate-100">
      <aside
        className={clsx(
          'flex flex-col border-r border-white/5 bg-surface-900/50 transition-[width] duration-200',
          collapsed ? 'w-16' : 'w-60'
        )}
      >
        {/* Brand */}
        <div className={clsx('flex h-16 shrink-0 items-center', collapsed ? 'justify-center px-2' : 'gap-2.5 px-4')}>
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-accent-400 to-accent-600 shadow-lg shadow-accent-500/30">
            <Share2 size={18} className="text-white" />
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold leading-tight">Manifold</p>
              <p className="mono truncate text-2xs text-slate-500">UNS · MQTT · OPC UA</p>
            </div>
          )}
        </div>

        {viewerReadOnly &&
          (collapsed ? (
            <Tooltip label="Read-only session — changes are rejected" side="right" className="mx-auto mb-1">
              <span className="grid h-8 w-8 place-items-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300">
                <Lock size={14} />
              </span>
            </Tooltip>
          ) : (
            <div className="mx-3 mb-1 flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-2xs font-medium text-amber-300">
              <Lock size={12} /> Read-only session
            </div>
          ))}

        <nav className={clsx('flex-1 space-y-4 overflow-y-auto py-2', collapsed ? 'px-2' : 'px-3')}>
          {NAV_GROUPS.map((group, gi) => (
            <div key={group.label || gi}>
              {group.label &&
                (collapsed ? (
                  gi > 0 && <div className="mx-auto mb-2 h-px w-6 bg-white/10" />
                ) : (
                  <p className="px-3 pb-1.5 text-2xs font-semibold uppercase tracking-widest text-slate-600">{group.label}</p>
                ))}
              <div className="space-y-1">
                {group.items.map((item) => (
                  <Tooltip key={item.to} label={collapsed ? item.label : ''} side="right" block>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) =>
                        clsx(
                          'flex items-center rounded-xl text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60',
                          collapsed ? 'h-11 w-full justify-center' : 'gap-3 px-3 py-2',
                          isActive
                            ? 'bg-accent-500/15 text-accent-300 ring-1 ring-inset ring-accent-500/25'
                            : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                        )
                      }
                    >
                      <item.icon size={18} className="shrink-0" />
                      {!collapsed && item.label}
                    </NavLink>
                  </Tooltip>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer: live status, logs, collapse toggle */}
        {collapsed ? (
          <div className="flex flex-col items-center gap-2 border-t border-white/5 py-3">
            <Tooltip label={connected ? 'Live — socket connected' : 'Offline — reconnecting'} side="right">
              <span className="grid h-8 w-8 place-items-center">
                <StatusDot status={connected ? 'connected' : 'disconnected'} />
              </span>
            </Tooltip>
            <ErrorLog collapsed />
            <IconButton icon={PanelLeftOpen} label="Expand sidebar  [" side="right" onClick={toggleNav} />
          </div>
        ) : (
          <div className="space-y-2 border-t border-white/5 px-4 py-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-slate-400">
                <StatusDot status={connected ? 'connected' : 'disconnected'} />
                {connected ? 'Live' : 'Offline'}
              </span>
              <span className="mono text-2xs text-slate-500">
                {brokers.length} brokers · {opcua.length} OPC UA
              </span>
            </div>
            <ErrorLog />
            <button
              onClick={toggleNav}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-2xs font-medium text-slate-500 transition hover:bg-white/5 hover:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60"
            >
              <PanelLeftClose size={14} /> Collapse
              <kbd className="mono ml-auto rounded border border-white/10 px-1 text-[10px] text-slate-600">[</kbd>
            </button>
          </div>
        )}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!connected && (
          // In-flow disconnect banner — pushes the page down instead of covering
          // its title bar (the old absolute overlay hid the header + actions).
          <div
            role="alert"
            className="flex shrink-0 items-center justify-center gap-2 bg-rose-600/90 px-4 py-1.5 text-2xs font-medium text-white"
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
            Connection to the Manifold server lost — live data is stale. Reconnecting…
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
