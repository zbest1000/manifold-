import clsx from 'clsx';

/** Small reusable presentational primitives shared across pages. */

export function Card({ className, children, ...rest }) {
  return (
    <div
      className={clsx(
        'rounded-2xl border border-white/5 bg-surface-900/60 backdrop-blur shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_8px_30px_-12px_rgba(0,0,0,0.6)]',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Button({ variant = 'primary', size = 'md', className, children, ...rest }) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]';
  const sizes = {
    sm: 'px-2.5 py-1.5 text-xs',
    md: 'px-3.5 py-2 text-sm',
    lg: 'px-5 py-2.5 text-sm'
  };
  const variants = {
    primary: 'bg-accent-500 text-white hover:bg-accent-400 shadow-lg shadow-accent-500/20',
    ghost: 'text-slate-300 hover:bg-white/5 hover:text-white',
    outline: 'border border-white/10 text-slate-200 hover:bg-white/5 hover:border-white/20',
    danger: 'bg-rose-500/90 text-white hover:bg-rose-500',
    subtle: 'bg-white/5 text-slate-200 hover:bg-white/10'
  };
  return (
    <button className={clsx(base, sizes[size], variants[variant], className)} {...rest}>
      {children}
    </button>
  );
}

const STATUS_STYLES = {
  connected: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  connecting: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  reconnecting: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  offline: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
  disconnected: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
  error: 'bg-rose-500/15 text-rose-300 ring-rose-500/30'
};

export function StatusDot({ status }) {
  const color =
    status === 'connected'
      ? 'bg-emerald-400'
      : status === 'error'
        ? 'bg-rose-400'
        : status === 'connecting' || status === 'reconnecting'
          ? 'bg-amber-400'
          : 'bg-slate-500';
  return (
    <span className="relative flex h-2.5 w-2.5">
      {status === 'connected' && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
      )}
      <span className={clsx('relative inline-flex h-2.5 w-2.5 rounded-full', color)} />
    </span>
  );
}

export function Badge({ status, children, className }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        STATUS_STYLES[status] || 'bg-white/5 text-slate-300 ring-white/10',
        className
      )}
    >
      {children || status}
    </span>
  );
}

export function Input({ className, ...rest }) {
  return (
    <input
      className={clsx(
        'w-full rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500',
        'focus:border-accent-500/60 focus:outline-none focus:ring-2 focus:ring-accent-500/20',
        className
      )}
      {...rest}
    />
  );
}

export function Field({ label, children }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
      {children}
    </label>
  );
}

export function EmptyState({ icon: Icon, title, hint, action }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      {Icon && (
        <div className="rounded-2xl bg-white/5 p-4 text-slate-400 ring-1 ring-inset ring-white/10">
          <Icon size={26} />
        </div>
      )}
      <div>
        <p className="text-sm font-semibold text-slate-200">{title}</p>
        {hint && <p className="mt-1 max-w-xs text-xs text-slate-500">{hint}</p>}
      </div>
      {action}
    </div>
  );
}
