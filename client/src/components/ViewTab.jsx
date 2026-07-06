import clsx from 'clsx';

/** Shared view-switcher tab (Graph / 3D / Tree …) used by the graph pages. */
export default function ViewTab({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition',
        active ? 'bg-accent-500/20 text-accent-200' : 'bg-surface-950/60 text-slate-400 hover:text-slate-200'
      )}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}
