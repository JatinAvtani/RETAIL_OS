import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

/** Joins class names, dropping falsy values — avoids pulling in a dependency for one 3-line helper. */
export const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

/* ---------------------------------------------------------------- page scaffolding */

export const PageHeader = ({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) => (
  <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-content">{title}</h1>
      {description && <p className="mt-1 max-w-2xl text-sm text-content-muted">{description}</p>}
    </div>
    {actions && <div className="flex items-center gap-2">{actions}</div>}
  </div>
);

export const Card = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div
    className={cx(
      'rounded-card border border-border bg-surface-raised shadow-[0_1px_2px_rgba(42,37,33,0.04)]',
      className
    )}
  >
    {children}
  </div>
);

export const CardHeader = ({ title, actions }: { title: string; actions?: ReactNode }) => (
  <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
    <h2 className="text-sm font-semibold text-content">{title}</h2>
    {actions}
  </div>
);

/* ---------------------------------------------------------------- feedback states */

export const EmptyState = ({ title, hint }: { title: string; hint?: string }) => (
  <div className="px-5 py-14 text-center">
    <p className="text-sm font-medium text-content">{title}</p>
    {hint && <p className="mt-1 text-sm text-content-subtle">{hint}</p>}
  </div>
);

export const LoadingState = ({ label = 'Loading…' }: { label?: string }) => (
  <div className="flex items-center justify-center gap-2 px-5 py-14 text-sm text-content-muted">
    <span className="size-3 animate-spin rounded-full border-2 border-border-strong border-t-accent" />
    {label}
  </div>
);

export const ErrorNotice = ({ children }: { children: ReactNode }) => (
  <div
    role="alert"
    className="mb-4 rounded-card border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger"
  >
    {children}
  </div>
);

/* ---------------------------------------------------------------- data display */

export type BadgeTone = 'neutral' | 'accent' | 'positive' | 'warning' | 'danger';

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-surface-sunken text-content-muted border-border',
  accent: 'bg-accent-soft text-accent border-accent/25',
  positive: 'bg-positive-soft text-positive border-positive/25',
  warning: 'bg-warning-soft text-warning border-warning/25',
  danger: 'bg-danger-soft text-danger border-danger/25',
};

export const Badge = ({ children, tone = 'neutral' }: { children: ReactNode; tone?: BadgeTone }) => (
  <span
    className={cx(
      'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
      badgeTones[tone]
    )}
  >
    {children}
  </span>
);

/**
 * Renders a value that may genuinely be unknown. A missing cost is NOT zero — showing "$0.00" for
 * an unpriced product silently reports 100% margin, the exact failure the costing invariants exist
 * to prevent. Anything nullable in a cost/quantity path renders through this.
 */
export const Value = ({ value, unit }: { value: string | number | null | undefined; unit?: string }) => {
  if (value === null || value === undefined || value === '') {
    return <span className="text-content-subtle italic">Unknown</span>;
  }
  return (
    <span className="tabular">
      {value}
      {unit ? <span className="ml-1 text-content-subtle">{unit}</span> : null}
    </span>
  );
};

/**
 * A headline figure. `value` of `null` renders an explicit "Unknown" rather than a zero — the same
 * rule `Value` enforces, applied to the largest, most trusted numbers on the screen, where a
 * fabricated zero would do the most damage.
 */
export const StatTile = ({
  label,
  value,
  unit,
  hint,
  tone = 'neutral',
  unknownReason,
  trendPoints,
  delta,
}: {
  label: string;
  value: string | null;
  unit?: string;
  hint?: string;
  tone?: 'neutral' | 'positive' | 'warning' | 'danger';
  unknownReason?: string;
  /** Optional 12-point trend series (dataviz figure contract). Omit entirely when no real history exists — never pass a fabricated flat series. */
  trendPoints?: number[];
  /** Optional signed period-over-period delta, rendered next to the sparkline via `TrendBadge`. */
  delta?: { direction: 'up' | 'down' | 'flat' | null; label: string; higherIsBetter?: boolean };
}) => {
  const toneClass =
    tone === 'positive'
      ? 'text-positive'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-content';

  return (
    <div className="rounded-card border border-border bg-surface-raised px-5 py-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-content-subtle">{label}</p>
      {value === null ? (
        <>
          <p className="mt-1.5 text-2xl font-semibold tracking-tight text-content-subtle">Unknown</p>
          {unknownReason && <p className="mt-1 text-xs text-content-subtle">{unknownReason}</p>}
        </>
      ) : (
        <>
          <div className="mt-1.5 flex items-end justify-between gap-3">
            <p className={cx('tabular text-2xl font-semibold tracking-tight', toneClass)}>
              {value}
              {unit && <span className="ml-1 text-base font-medium text-content-muted">{unit}</span>}
            </p>
            {trendPoints && trendPoints.length >= 2 && <Sparkline points={trendPoints} />}
          </div>
          {(hint || delta) && (
            <div className="mt-1 flex items-center gap-2">
              {delta && <TrendBadge direction={delta.direction} label={delta.label} higherIsBetter={delta.higherIsBetter ?? true} />}
              {hint && <p className="text-xs text-content-subtle">{hint}</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
};

/**
 * A signed period-over-period delta badge (dataviz skill: "delta — signed, vs a named period;
 * color = direction × whether up is good"). `higherIsBetter` decouples the raw direction from its
 * meaning — a rising food cost % is bad, a rising contribution margin % is good, so the SAME
 * up-arrow must be colored oppositely depending on which metric it's attached to. `direction: null`
 * (no comparison basis available, e.g. the prior period itself is unknown) renders neutrally rather
 * than fabricating a verdict from an incomplete comparison — the same I7 discipline `StatTile`
 * already applies to its own headline value.
 */
export const TrendBadge = ({
  direction,
  label,
  higherIsBetter = true,
}: {
  direction: 'up' | 'down' | 'flat' | null;
  label: string;
  higherIsBetter?: boolean;
}) => {
  if (direction === null) {
    return <span className="text-xs text-content-subtle">{label}</span>;
  }
  const isGood = direction === 'flat' ? null : direction === 'up' ? higherIsBetter : !higherIsBetter;
  const toneClass = isGood === null ? 'text-content-subtle' : isGood ? 'text-positive' : 'text-danger';
  const arrow = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→';
  return (
    <span className={cx('inline-flex items-center gap-1 text-xs font-medium', toneClass)}>
      <span aria-hidden="true">{arrow}</span>
      {label}
    </span>
  );
};

/**
 * A 12-point trend line for a `StatTile` (dataviz skill's own figure contract: "trend — optional;
 * 12-point sparkline in the de-emphasis hue, current period in the accent"). Deliberately the
 * simplest possible mark — a single 2px polyline, no axes/gridlines/legend (a single-series
 * micro-chart needs none, per the marks-and-anatomy reference) — since this rides inside a stat
 * tile, not a standalone chart. Renders nothing (not a flat/misleading line) when fewer than 2 real
 * points exist, matching I7's "insufficient data says so" rule rather than drawing a fabricated flat
 * line across a gap.
 */
export const Sparkline = ({ points, width = 96, height = 28 }: { points: number[]; width?: number; height?: number }) => {
  const real = points.filter((p) => Number.isFinite(p));
  if (real.length < 2) return null;

  const min = Math.min(...real);
  const max = Math.max(...real);
  const range = max - min;
  const stepX = width / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = i * stepX;
    const y = range === 0 ? height / 2 : height - ((p - min) / range) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const lastCoord = coords[coords.length - 1]!.split(',').map(Number) as [number, number];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Trend over the period">
      <polyline
        points={coords.slice(0, -1).join(' ')}
        fill="none"
        stroke="var(--color-content-subtle)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        points={`${coords[coords.length - 2] ?? coords[0]} ${coords[coords.length - 1]}`}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lastCoord[0]} cy={lastCoord[1]} r={3} fill="var(--color-accent)" stroke="var(--color-surface-raised, #fff)" strokeWidth={2} />
    </svg>
  );
};

export const Table = ({ children }: { children: ReactNode }) => (
  <div className="overflow-x-auto">
    <table className="w-full border-collapse text-sm">{children}</table>
  </div>
);

export const Th = ({ children, align = 'left' }: { children?: ReactNode; align?: 'left' | 'right' }) => (
  <th
    className={cx(
      'border-b border-border px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-content-subtle',
      align === 'right' ? 'text-right' : 'text-left'
    )}
  >
    {children}
  </th>
);

export const Td = ({
  children,
  align = 'left',
  className,
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) => (
  <td
    className={cx(
      'border-b border-border px-5 py-3 text-content',
      align === 'right' ? 'text-right' : 'text-left',
      className
    )}
  >
    {children}
  </td>
);

export const Tr = ({ children }: { children: ReactNode }) => (
  <tr className="transition-colors hover:bg-surface-sunken/60">{children}</tr>
);

/* ---------------------------------------------------------------- controls */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-content hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface-raised text-content hover:bg-surface-sunken border-border-strong',
  ghost: 'bg-transparent text-content-muted hover:text-content hover:bg-surface-sunken border-transparent',
  danger: 'bg-transparent text-danger hover:bg-danger-soft border-danger/30',
};

export const Button = ({
  variant = 'secondary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) => (
  <button
    className={cx(
      'inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium',
      'transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
      'disabled:cursor-not-allowed disabled:opacity-50',
      buttonVariants[variant],
      className
    )}
    {...props}
  />
);

const fieldStyles =
  'w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-1.5 text-sm text-content ' +
  'placeholder:text-content-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const Input = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
  <input className={cx(fieldStyles, className)} {...props} />
);

export const Select = ({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={cx(fieldStyles, 'pr-8', className)} {...props} />
);

export const Field = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) => (
  <label className="block">
    <span className="mb-1.5 block text-sm font-medium text-content">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-xs text-content-subtle">{hint}</span>}
  </label>
);
