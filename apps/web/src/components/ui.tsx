import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import Link from 'next/link';

/** Joins class names, dropping falsy values — avoids pulling in a dependency for one 3-line helper. */
export const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

/*
 * One spacing and type scale, used everywhere, on purpose — not per-component guesses. Odd,
 * uneven spacing/hierarchy is what happens when nearby components each pick their own numbers;
 * this file leans on Tailwind's own step (4px per unit, and its named text sizes) rather than
 * arbitrary bracket values, so a card, a table cell and a stat tile that sit next to each other
 * actually share a rhythm.
 *
 * Text:    text-xs (12px) labels, captions, table headers, badges
 *          text-sm (14px) body copy, buttons, inputs, table cells
 *          text-base/lg   section and page headings
 *          text-2xl/3xl   the one or two largest figures on a screen
 * Padding: px-4 py-3     compact containers (stat tiles, table cells)
 *          px-5 py-4     roomier containers (card bodies, empty states)
 * Gaps:    gap-1.5       tight inline groups (icon + label, badge dot + text)
 *          gap-2         control rows, toolbars
 *          gap-4 / gap-6 layout-level spacing between blocks
 */

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
  <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
    <div>
      {/* A short brass rule above the title. The page heading previously started flush against the
          content with nothing separating it from the body, so every screen opened flat; this gives
          each page a deliberate masthead without adding a heavy bar or a second background. */}
      <span aria-hidden="true" className="mb-2.5 block h-0.5 w-8 rounded-full bg-accent" />
      <h1 className="text-2xl font-semibold tracking-[-0.02em] text-content">{title}</h1>
      {description && <p className="mt-1 max-w-2xl text-sm text-content-muted">{description}</p>}
    </div>
    {actions && <div className="flex items-center gap-2">{actions}</div>}
  </div>
);

export const Card = ({ children, className }: { children: ReactNode; className?: string }) => (
  // A single hairline shadow, not a soft drop shadow: enough to lift a card off the paper-grey
  // ground so stacked surfaces read as layered rather than as one flat wash, while staying inside
  // the "ruled and printed" register the 3px radius sets.
  <div className={cx('rounded-card border border-border bg-surface-raised shadow-sm', className)}>{children}</div>
);

export const CardHeader = ({ title, actions }: { title: string; actions?: ReactNode }) => (
  <div className="flex items-center justify-between border-b border-border px-5 py-3">
    <h2 className="text-base font-semibold text-content">{title}</h2>
    {actions}
  </div>
);

/* ---------------------------------------------------------------- guidance */

/**
 * a small, reusable tooltip for the handful of controls in this app that are genuinely
 * unclear without one. Deliberately NOT for every control — over-tooltipping trains people to
 * ignore tooltips, and this codebase's own demonstrated convention everywhere else (`Field.hint`,
 * `EmptyState.hint`, `StatTile.unknownReason`) is ALWAYS-VISIBLE guidance, not hover-gated — a real
 * pattern worth following before reaching for this component. Two real placements were tried while
 * building this (a `StatTile` label inside `StatTileGrid`, a CSV-import field label) and both hit
 * genuine structural conflicts (see below) or were simply better served by `Field.hint` — this
 * component currently has NO live caller in the app, and that's a deliberate, confirmed decision,
 * not an oversight: it ships as real, tested, available infrastructure for a future spot cramped
 * enough that an always-visible hint genuinely doesn't fit (e.g. a dense table-header abbreviation).
 *
 * KNOWN STRUCTURAL LIMITATION, confirmed by live screenshot before this note was written: `position:
 * absolute` positioning here is clipped by ANY ancestor with `overflow: hidden`/`overflow: auto` —
 * `StatTileGrid` (rounded-corner clipping) and `Table` (`overflow-auto` for horizontal scroll) both
 * do this. A future caller inside either container will need a different positioning strategy (or a
 * true floating-UI library) — don't assume this component is safe to drop into an arbitrary
 * container without checking its overflow behavior first.
 *
 * Pure CSS (`group-hover`/`group-focus-within`, the same pattern this file already uses for
 * `Tr`'s hover-reveal actions), not a `useState`-driven show/hide — this file has no `'use client'`
 * boundary today and is imported by both server and client components; a stateful tooltip would
 * force every consumer of `ui.tsx` into the client bundle just to render this one control.
 *
 * The bubble is always present in the DOM (never `aria-hidden`), linked via `aria-describedby` on
 * the trigger, so a screen reader announces it as part of the trigger's accessible description
 * regardless of hover/focus state — CSS visibility is a sighted-user affordance only, not the
 * accessibility mechanism. `id` is caller-supplied (not generated internally) since this file has
 * no `'use client'`/hook boundary to safely call `useId` from.
 */
export const Tooltip = ({ id, text, children }: { id: string; text: string; children: ReactNode }) => (
  <span className="group relative inline-flex">
    <span aria-describedby={id} tabIndex={0} className="inline-flex rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
      {children}
    </span>
    <span
      id={id}
      role="tooltip"
      className={cx(
        'pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-max max-w-xs -translate-x-1/2 rounded-sm bg-content px-2.5 py-1.5 text-xs text-surface opacity-0 shadow-md transition-opacity',
        'group-hover:opacity-100 group-focus-within:opacity-100'
      )}
    >
      {text}
    </span>
  </span>
);

/* ---------------------------------------------------------------- feedback states */

/**
 * Two genuinely different facts, deliberately given two different looks. "You have no purchase
 * orders yet" and "your filters matched nothing" mean opposite things — conflating them makes a
 * user with an over-narrow filter believe their data vanished. `no-data` offers the action that
 * creates the first record; `no-matches` offers the one that widens the search.
 */
export const EmptyState = ({
  title,
  hint,
  variant = 'no-data',
  action,
}: {
  title: string;
  hint?: string;
  variant?: 'no-data' | 'no-matches';
  action?: ReactNode;
}) => (
  <div className="px-5 py-14 text-center">
    {/* A quiet mark above the message. Two different glyphs for two genuinely different facts —
        a dashed outline for "nothing here yet" vs. a magnifier for "your filter matched nothing" —
        so the distinction the two variants exist to carry survives even before the words are read. */}
    <span
      aria-hidden="true"
      className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full border border-border bg-surface-sunken text-content-subtle"
    >
      {variant === 'no-matches' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="size-5">
          <circle cx="11" cy="11" r="6" />
          <path d="M20 20l-4.5-4.5" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="3 3" className="size-5">
          <rect x="4" y="4" width="16" height="16" rx="2" />
        </svg>
      )}
    </span>
    {variant === 'no-matches' && (
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-content-subtle">No matches</p>
    )}
    <p className="text-base font-semibold text-content">{title}</p>
    {hint && <p className="mx-auto mt-1 max-w-sm text-sm text-content-muted">{hint}</p>}
    {action && <div className="mt-4 flex justify-center">{action}</div>}
  </div>
);

export const LoadingState = ({ label = 'Loading…' }: { label?: string }) => (
  <div className="flex items-center justify-center gap-2 px-5 py-14 text-sm text-content-muted">
    <span className="size-3 animate-spin rounded-full border-2 border-border-strong border-t-accent" />
    {label}
  </div>
);

/**
 * Skeleton rows for a table region. Preferred over a spinner anywhere the shape of the incoming
 * content is already known — the layout doesn't jump when data lands, which on a dense screen is
 * the difference between "it loaded" and "everything moved".
 */
export const SkeletonRows = ({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) => (
  <div className="px-5 py-2" aria-hidden="true">
    {Array.from({ length: rows }).map((_, rowIndex) => (
      <div key={rowIndex} className="flex items-center gap-4 border-b border-border py-3 last:border-b-0">
        {Array.from({ length: columns }).map((_, columnIndex) => (
          <div
            key={columnIndex}
            className="skeleton h-3.5"
            style={{ width: columnIndex === 0 ? '32%' : `${Math.max(10, 22 - columnIndex * 3)}%` }}
          />
        ))}
      </div>
    ))}
    <span className="sr-only">Loading rows…</span>
  </div>
);

/**
 * A stat tile mid-load. Deliberately a skeleton bar at figure size and never a zero or the previous
 * value — a stale number presented as current is the same failure class as a fabricated one.
 */
export const SkeletonFigure = () => (
  <div className="px-4 py-3" aria-hidden="true">
    <div className="skeleton h-2.5 w-24" />
    <div className="skeleton mt-3 h-7 w-32" />
    <div className="skeleton mt-3 h-2.5 w-20" />
    <span className="sr-only">Loading figure…</span>
  </div>
);

/**
 * An error the user can act on. Body text stays ink-coloured rather than red — red body text is
 * measurably harder to read, and this is precisely the moment reading matters. The danger colour
 * lives in the left edge and border, where it signals without impeding.
 */
export const ErrorNotice = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div
    role="alert"
    className="mb-4 rounded-card border border-danger/30 border-l-[3px] border-l-danger bg-surface-raised px-4 py-3"
  >
    <div className="text-sm text-content">{children}</div>
    {action && <div className="mt-2.5">{action}</div>}
  </div>
);

/* ---------------------------------------------------------------- data display */

export type BadgeTone = 'neutral' | 'accent' | 'positive' | 'warning' | 'danger' | 'unknown';

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-surface-sunken text-content-muted border-border-strong',
  accent: 'bg-accent-soft text-accent border-accent/35',
  positive: 'bg-positive-soft text-positive border-positive/35',
  warning: 'bg-warning-soft text-warning border-warning/35',
  danger: 'bg-danger-soft text-danger border-danger/35',
  unknown: 'bg-transparent text-unknown border-border-strong border-dashed',
};

/**
 * A stamped record status, not a consumer tag — hence a 3px radius rather than a pill.
 *
 * The leading dot is the redundant non-colour channel: `unknown` renders it as a hollow ring on a
 * dashed border, so "we don't know" is distinguishable from every real status without any colour
 * perception at all. Carries state only — never an action, never a count.
 */
export const Badge = ({ children, tone = 'neutral' }: { children: ReactNode; tone?: BadgeTone }) => (
  <span
    className={cx(
      'inline-flex items-center gap-1.5 rounded-control border px-2 py-0.5',
      'font-mono text-xs font-semibold uppercase tracking-wide',
      badgeTones[tone]
    )}
  >
    <span
      aria-hidden="true"
      className={cx(
        'size-1.5 rounded-full',
        tone === 'unknown' ? 'ring-1 ring-inset ring-current' : 'bg-current'
      )}
    />
    {children}
  </span>
);

/**
 * Renders a value that may genuinely be unknown. A missing cost is NOT zero — showing "$0.00" for
 * an unpriced product silently reports 100% margin, the exact failure the costing invariants exist
 * to prevent. Anything nullable in a cost/quantity path renders through this.
 *
 * A real value gets the mono face; an unknown one gets the body face, italic, in `--color-unknown`.
 * That is three simultaneous differences (typeface, style, colour) rather than one, so the
 * distinction holds up in greyscale and for a colourblind reader. The copy is "Not known" — never
 * an em-dash, a blank, or a zero, each of which reads as a value rather than an absence.
 */
export const Value = ({ value, unit }: { value: string | number | null | undefined; unit?: string }) => {
  if (value === null || value === undefined || value === '') {
    return <span className="italic text-unknown">Not known</span>;
  }
  return (
    <span className="font-mono tabular-nums">
      {value}
      {unit ? <span className="ml-1 text-content-muted">{unit}</span> : null}
    </span>
  );
};

/**
 * A headline figure. `value` of `null` renders an explicit "Not known" rather than a zero — the same
 * rule `Value` enforces, applied to the largest, most trusted numbers on the screen, where a
 * fabricated zero would do the most damage.
 *
 * `unknownReason` is REQUIRED, not optional. An unexplained absence is a bug report the user can't
 * file: "Not known" tells them the system is being honest, but only the reason tells them whether
 * it's their missing invoice or our missing permission — and therefore whether they can fix it.
 *
 * The figure itself is never coloured by status. A green number invites reading the colour instead
 * of the digit; status lives in the delta and in any severity marker, never in the value.
 */
export const StatTile = ({
  label,
  value,
  unit,
  hint,
  unknownReason,
  trendPoints,
  delta,
  footer,
  href,
}: {
  label: string;
  value: string | null;
  unit?: string;
  hint?: string;
  /** Why this figure is unknown. Required — see the component comment. */
  unknownReason: string;
  /** Optional 12-point trend series. Omit entirely when no real history exists — never a fabricated flat series. */
  trendPoints?: number[];
  /** Optional signed period-over-period delta, rendered beneath the figure via `TrendBadge`. */
  delta?: { direction: 'up' | 'down' | 'flat' | null; label: string; higherIsBetter?: boolean };
  /** Optional always-visible slot beneath the figure — a status badge, not a disclosure. */
  footer?: ReactNode;
  /**
   * Optional destination for "why is this number true" — provenance + source rows. A real page
   * (`/dashboard/metric/[figure]`), not an inline expansion: a `StatTile` is a quarter-width grid
   * column, and neither a provenance list nor a 3-column source-rows table has room to lay out
   * cleanly at that width, which is what caused a real horizontal-overflow bug the first two times
   * this was tried inline. `href` makes the whole tile a link — plain `next/link`, not a
   * `useState`-driven expand/collapse, since this file has no `'use client'` boundary and is
   * imported by both server and client components (see the shared-tooltip note above for why that
   * matters).
   */
  href?: string;
}) => {
  // `transition-colors` + a sunken hover: the tiles are the densest, most-read part of the app,
  // and a tile that responds to the cursor makes an otherwise-static grid feel like an instrument
  // panel rather than a printed table. Colour only — no lift or scale, which would fight the flat
  // register.
  // `flex flex-col h-full`: StatTileGrid stretches every tile to the row's tallest sibling
  // (grid's default `align-items: stretch`), so a short tile (no sparkline) ends up taller than its
  // own content — `mt-auto` on `footer` is what puts that slack in one place instead of leaving it
  // as dead space between the value and the bottom of the tile.
  const body = (
    <>
      <p className="text-xs font-semibold uppercase tracking-wide text-content-subtle">{label}</p>
      {value === null ? (
        <>
          <p className="mt-3 text-xl italic leading-none text-unknown">Not known</p>
          <p className="mt-2 text-xs leading-snug text-content-subtle">{unknownReason}</p>
        </>
      ) : (
        <>
          <p className="mt-3 font-mono text-2xl font-semibold leading-none tracking-[-0.02em] tabular-nums text-content">
            {value}
            {unit && <span className="ml-0.5 text-sm font-normal text-content-muted">{unit}</span>}
          </p>
          {(hint || delta) && (
            <div className="mt-2.5 flex flex-col gap-0.5">
              {delta && (
                <TrendBadge
                  direction={delta.direction}
                  label={delta.label}
                  higherIsBetter={delta.higherIsBetter ?? true}
                />
              )}
              {hint && <p className="text-xs text-content-subtle">{hint}</p>}
            </div>
          )}
          {trendPoints && trendPoints.length >= 2 && <Sparkline points={trendPoints} />}
        </>
      )}
      {(footer || href) && (
        <div className="mt-auto flex items-center justify-between gap-2 pt-3">
          {footer}
          {href && <span className="text-xs font-medium text-accent">View details →</span>}
        </div>
      )}
    </>
  );

  const className = 'flex h-full min-w-0 flex-col bg-surface-raised px-4 py-4 text-left transition-colors hover:bg-surface';

  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
};

/**
 * The 1px-gap grid that joins stat tiles into one instrument panel rather than leaving them as four
 * unrelated floating cards. The gap shows the container's border colour through, so neighbouring
 * tiles share a hairline instead of each carrying their own.
 */
export const StatTileGrid = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => (
  <div
    className={cx(
      'grid gap-px overflow-hidden rounded-card border border-border bg-border',
      'sm:grid-cols-2 lg:grid-cols-4',
      className
    )}
  >
    {children}
  </div>
);

/**
 * A signed period-over-period delta. `higherIsBetter` decouples the raw direction from its meaning —
 * a rising food cost % is bad, a rising contribution margin % is good, so the SAME up-arrow must be
 * coloured oppositely depending on which metric it's attached to.
 *
 * The basis label ("vs prior 30 days") is not decoration: a delta without a stated basis is not a
 * fact. `direction: null` (no comparison basis available) renders neutrally and drops the glyph
 * rather than fabricating a verdict from an incomplete comparison — the same I7 discipline
 * `StatTile` applies to its own headline value.
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
  const glyph = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '●';
  return (
    <span className={cx('inline-flex items-center gap-1.5 font-mono text-xs font-semibold', toneClass)}>
      <span aria-hidden="true">{glyph}</span>
      {label}
    </span>
  );
};

/**
 * A trend line for a `StatTile`. Deliberately the simplest possible mark — no axes, gridlines,
 * legend or fill — since this rides inside a stat tile rather than standing alone as a chart. Prior
 * periods are drawn in the de-emphasis hue and only the final segment plus its endpoint take the
 * accent, so the eye lands on "where it is now" rather than tracing the whole series.
 *
 * Renders nothing (not a flat, misleading line) when fewer than 2 real points exist, matching I7's
 * "insufficient data says so" rule rather than drawing a fabricated line across a gap.
 */
export const Sparkline = ({ points, width = 140, height = 30 }: { points: number[]; width?: number; height?: number }) => {
  const real = points.filter((p) => Number.isFinite(p));
  if (real.length < 2) return null;

  const min = Math.min(...real);
  const max = Math.max(...real);
  const range = max - min;
  // Inset vertically by the endpoint dot's radius so the dot never clips at the top or bottom edge.
  const pad = 3;
  const stepX = (width - pad) / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = i * stepX;
    const y = range === 0 ? height / 2 : height - pad - ((p - min) / range) * (height - pad * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const lastCoord = coords[coords.length - 1]!.split(',').map(Number) as [number, number];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="mt-2 block"
      role="img"
      aria-label="Trend over the period"
    >
      <polyline
        points={coords.slice(0, -1).join(' ')}
        fill="none"
        stroke="var(--color-content-subtle)"
        strokeWidth={1.5}
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
      <circle
        cx={lastCoord[0]}
        cy={lastCoord[1]}
        r={2.5}
        fill="var(--color-accent)"
        stroke="var(--color-surface-raised)"
        strokeWidth={1.5}
      />
    </svg>
  );
};

/**
 * A ranked horizontal-bar list — top/bottom items by contribution, waste by reason, anything that
 * was previously just a `Table` of label+value with no sense of relative scale. Bars are drawn
 * against the row's OWN maximum (not a shared axis with other charts on the page), so "which of
 * these five rows is biggest" reads instantly without needing a printed axis.
 *
 * Every bar is a real `<button>` when `onSelect` is given (keyboard-reachable, not a mouse-only
 * hover target) rather than a decorative rectangle — the same "never a dead end" discipline the
 * dashboard's drill-through panels already apply to figures. `tone` lets a caller flag a row as
 * bad news (e.g. the bottom-contribution list) without inventing a second colour language — it
 * reuses the same status tokens `Badge`/`TrendBadge` already carry.
 *
 * Renders nothing for an empty list — an empty bar chart with a "0" axis is exactly the kind of
 * fabricated-looking-real emptiness I7 exists to avoid; the caller's own `EmptyState` covers this.
 */
export const BarComparison = ({
  rows,
  formatValue,
  tone = 'accent',
}: {
  rows: { key: string; label: string; value: number; onSelect?: () => void }[];
  /** How the raw number renders beside the bar — the caller already has the real currency/unit formatter. */
  formatValue: (value: number) => string;
  tone?: 'accent' | 'danger' | 'warning' | 'positive';
}) => {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 0);
  const barToneClass: Record<typeof tone, string> = {
    accent: 'bg-accent',
    danger: 'bg-danger',
    warning: 'bg-warning',
    positive: 'bg-positive',
  };

  return (
    <ul className="space-y-2.5 px-5 py-4">
      {rows.map((row) => {
        const pct = max > 0 ? (Math.abs(row.value) / max) * 100 : 0;
        const content = (
          <>
            <span className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-content">{row.label}</span>
              <span className="shrink-0 font-mono tabular-nums text-content-muted">{formatValue(row.value)}</span>
            </span>
            <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-surface-sunken">
              <span
                className={cx('block h-full rounded-full transition-[width]', barToneClass[tone])}
                style={{ width: `${pct}%` }}
              />
            </span>
          </>
        );
        return (
          <li key={row.key}>
            {row.onSelect ? (
              <button
                type="button"
                onClick={row.onSelect}
                className="block w-full rounded-control text-left transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {content}
              </button>
            ) : (
              <div>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
};

/**
 * A single diverging bar for a value measured against zero — cost variance (over/under recipe),
 * a supplier's price drift, anything where the SIGN carries the meaning and not just the
 * magnitude. Deliberately one bar, not a chart: this exists for the one or two headline variance
 * figures on a page, where the shape ("how far, which direction") is the whole point and a real
 * axis with gridlines would be over-built for a single measurement.
 *
 * `direction` decides colour, not the raw sign of `value` — the same reason `TrendBadge` takes
 * `higherIsBetter` instead of inferring good/bad from up/down: "over recipe" is bad regardless of
 * whether the stored number is positive or negative, and the caller (which knows the business
 * meaning) is the only one who can say so honestly.
 */
export const DivergingBar = ({
  value,
  maxMagnitude,
  direction,
}: {
  value: number;
  /** The scale the bar is drawn against — typically the larger of the two sides being compared (e.g. actual vs theoretical). */
  maxMagnitude: number;
  direction: 'over' | 'under' | 'exact' | 'unknown';
}) => {
  if (direction === 'unknown' || maxMagnitude === 0) return null;
  const toneClass = direction === 'over' ? 'bg-danger' : direction === 'under' ? 'bg-warning' : 'bg-content-subtle';
  const pct = Math.min(100, (Math.abs(value) / maxMagnitude) * 100);

  return (
    <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken" role="img" aria-label={`Variance bar, ${direction === 'over' ? 'over' : direction === 'under' ? 'under' : 'at'} recipe`}>
      <div className="flex w-1/2 justify-end">
        {direction === 'under' && <div className={cx('h-full rounded-l-full', toneClass)} style={{ width: `${pct}%` }} />}
      </div>
      <div className="w-px shrink-0 bg-border-strong" />
      <div className="flex w-1/2 justify-start">
        {(direction === 'over' || direction === 'exact') && (
          <div className={cx('h-full rounded-r-full', toneClass)} style={{ width: direction === 'exact' ? '2px' : `${pct}%` }} />
        )}
      </div>
    </div>
  );
};

/**
 * The margin waterfall: base contribution margin -> price/cost/mix/volume effects, each stepping
 * from the running total -> the new contribution margin. A real waterfall (each bar starts where
 * the previous one ended), not a bar-comparison chart — the running-total connector between steps
 * is what makes "how did we get from X to Y" legible at a glance, which four independent bars
 * side by side cannot show.
 *
 * `higherIsBetter` per step is a fixed design decision (an effect is bad when it REDUCES margin,
 * regardless of the raw sign a caller's data happens to produce) — this component does not accept
 * it as a prop, unlike `TrendBadge`, because there is only one honest reading of "cost went up
 * and ate into margin" for this specific chart.
 */
export const MarginWaterfall = ({
  base,
  steps,
  formatValue,
}: {
  /** The starting bar — the base period's own real contribution margin. */
  base: { label: string; value: number };
  /** Each effect, in the fixed price/cost/mix/volume order the spec's own decomposition defines. */
  steps: { key: string; label: string; value: number }[];
  formatValue: (value: number) => string;
}) => {
  const total = base.value + steps.reduce((sum, s) => sum + s.value, 0);
  const bars = [
    { key: 'base', label: base.label, value: base.value, kind: 'anchor' as const },
    ...steps.map((s) => ({ ...s, kind: 'step' as const })),
    { key: 'total', label: 'New margin', value: total, kind: 'anchor' as const },
  ];

  // The scale every bar is drawn against — the largest cumulative magnitude reached at any point
  // in the walk, so a big early swing doesn't clip a smaller later one off the top.
  let running = base.value;
  const cumulativeMagnitudes = [Math.abs(base.value)];
  for (const s of steps) {
    running += s.value;
    cumulativeMagnitudes.push(Math.abs(running));
  }
  const maxMagnitude = Math.max(...cumulativeMagnitudes, 1);

  running = base.value;
  return (
    <div role="img" aria-label={`Margin waterfall from ${formatValue(base.value)} to ${formatValue(total)}`} className="px-5 py-4">
      <ul className="space-y-3">
        {bars.map((bar) => {
          const isAnchor = bar.kind === 'anchor';
          const barStart = isAnchor ? 0 : running;
          if (!isAnchor) running += bar.value;
          const barEnd = isAnchor ? bar.value : running;

          const left = (Math.min(barStart, barEnd) / maxMagnitude) * 50 + 50;
          const width = (Math.abs(barEnd - barStart) / maxMagnitude) * 50;
          const tone = isAnchor ? 'bg-accent' : bar.value >= 0 ? 'bg-positive' : 'bg-danger';

          return (
            <li key={bar.key}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-content">{bar.label}</span>
                <span className={cx('shrink-0 font-mono tabular-nums', isAnchor ? 'text-content font-semibold' : bar.value >= 0 ? 'text-positive' : 'text-danger')}>
                  {isAnchor ? formatValue(bar.value) : `${bar.value >= 0 ? '+' : ''}${formatValue(bar.value)}`}
                </span>
              </div>
              <div className="relative mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-surface-sunken">
                <div
                  className={cx('absolute h-full rounded-full', tone)}
                  style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
                />
                {/* The zero line — the fixed reference every bar's position is read against. */}
                <div className="absolute inset-y-0 left-1/2 w-px bg-border-strong" />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

/* ---------------------------------------------------------------- tables */

/**
 * The scroll container is also the sticky-positioning context, which is why the header's
 * `position: sticky` lives on the `<th>` rather than the row — sticky inside an `overflow` ancestor
 * only resolves against that ancestor.
 */
export const Table = ({
  children,
  className,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  /** Names the table for assistive tech — a screen-reader user landing in a grid of numbers needs to know WHICH numbers before reading any of them. */
  'aria-label'?: string;
}) => (
  <div className={cx('relative max-h-[70vh] min-w-0 overflow-auto', className)}>
    <table className="w-full border-collapse text-sm" {...(ariaLabel !== undefined ? { 'aria-label': ariaLabel } : {})}>
      {children}
    </table>
  </div>
);

/** The filter/control bar that belongs to a table. Lives inside the table's own container — filters visually detached from what they filter is a recurring usability failure. */
export const TableToolbar = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-raised px-4 py-2.5">
    {children}
  </div>
);

export const Th = ({
  children,
  align = 'left',
  className,
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) => (
  <th
    // Every Th in this codebase heads a column (row headers would use a raw <th scope="row">), so
    // the scope is declared here once rather than remembered at 26 call sites.
    scope="col"
    className={cx(
      'sticky top-0 z-10 border-b border-border-strong bg-surface-sunken px-4 py-2.5',
      'text-xs font-semibold uppercase tracking-wide text-content-subtle',
      align === 'right' ? 'text-right' : 'text-left',
      className
    )}
  >
    {children}
  </th>
);

export const Td = ({
  children,
  align = 'left',
  className,
  variant,
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
  className?: string;
  /**
   * `numeric` sets the mono face and right-aligns — use it for every money, quantity, percentage and
   * count, with no exceptions. A single proportional figure in a mono column is instantly visible as
   * wrong, which is exactly the feedback you want.
   *
   * `actions` holds inline row actions: quiet until the row is hovered or focused, but never hidden,
   * so keyboard users can still reach them.
   */
  variant?: 'numeric' | 'actions';
}) => (
  <td
    className={cx(
      'border-b border-border px-4 py-2.5 text-content',
      variant === 'numeric' && 'font-mono tabular-nums text-right',
      variant === 'actions' &&
        'text-right whitespace-nowrap opacity-55 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
      variant === undefined && (align === 'right' ? 'text-right' : 'text-left'),
      variant === 'numeric' && align === 'left' && 'text-left',
      className
    )}
  >
    {children}
  </td>
);

/**
 * `severity` draws a 3px left edge rather than tinting the whole row. A tinted row background makes
 * the text inside it harder to read at exactly the moment it matters most; an edge marker is just as
 * scannable and costs nothing in legibility.
 *
 * `selected` wins over `severity` — when a row is both, selection is the state the user just created
 * and is acting on.
 */
export const Tr = ({
  children,
  severity,
  selected,
  className,
}: {
  children: ReactNode;
  severity?: 'watch' | 'short';
  selected?: boolean;
  className?: string;
}) => (
  <tr
    className={cx(
      'group border-l-[3px] transition-colors',
      selected
        ? 'border-l-accent bg-accent-soft'
        : severity === 'short'
          ? 'border-l-danger hover:bg-surface-sunken'
          : severity === 'watch'
            ? 'border-l-warning hover:bg-surface-sunken'
            : 'border-l-transparent hover:bg-surface-sunken',
      'even:bg-surface-sunken/45',
      selected && 'even:bg-accent-soft',
      className
    )}
  >
    {children}
  </tr>
);

/* ---------------------------------------------------------------- controls */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-content hover:bg-accent-hover border-accent',
  secondary: 'bg-surface-raised text-content hover:bg-surface-sunken border-border-strong',
  ghost: 'bg-transparent text-content-muted hover:text-content hover:bg-surface-sunken border-transparent',
  // Never a solid red fill: a filled danger button competes with the primary action for attention
  // and gets clicked by accident. Anything irreversible needs a confirmation step as well — the
  // button's styling is not the safeguard.
  danger: 'bg-transparent text-danger hover:bg-danger-soft border-danger/40',
};

/**
 * `size="lg"` exists for exactly one real reason: the standard 44x44px touch-target minimum
 * (WCAG 2.5.5 / iOS HIG) — the default `py-1.5` control computes to ~32px tall, fine for a mouse
 * pointer but a genuine mis-tap risk on a phone/tablet screen. Deliberately opt-in, not a size
 * change to the default: every desktop screen in this app was designed and screenshotted against
 * the current density, and inflating every button/input app-wide would be a much bigger, uninvited
 * visual change for a problem that's real only on the handful of screens someone actually operates
 * one-handed on a device (receiving, stocktake) — see those pages' own card-per-row mobile layout,
 * the first real callers of `size="lg"`.
 */
export type ControlSize = 'default' | 'lg';

const buttonSizes: Record<ControlSize, string> = {
  default: 'px-4 py-1.5 text-sm',
  lg: 'px-5 py-3 text-base min-h-11',
};

export const Button = ({
  variant = 'secondary',
  size = 'default',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ControlSize }) => (
  <button
    className={cx(
      'inline-flex items-center justify-center gap-1.5 rounded-control border font-semibold',
      'transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
      'disabled:cursor-not-allowed disabled:opacity-45',
      buttonSizes[size],
      buttonVariants[variant],
      className
    )}
    {...props}
  />
);

const fieldSizes: Record<ControlSize, string> = {
  default: 'px-3 py-1.5 text-sm',
  lg: 'px-4 py-3 text-base min-h-11',
};

const fieldStyles =
  'w-full rounded-control border border-border-strong bg-surface-raised text-content ' +
  'placeholder:text-content-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 ' +
  'disabled:cursor-not-allowed disabled:opacity-45';

export const Input = ({
  className,
  size = 'default',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & { size?: ControlSize }) => (
  <input className={cx(fieldStyles, fieldSizes[size], className)} {...props} />
);

export const Select = ({
  className,
  size = 'default',
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & { size?: ControlSize }) => (
  <select className={cx(fieldStyles, fieldSizes[size], 'pr-8', className)} {...props} />
);

export const Field = ({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  /**
   * A field-level validation message. Rendered inside the wrapping label (so assistive tech reads
   * it with the field's name) with an icon AND text — the invalid state is never colour alone.
   * Pass `aria-invalid` on the input itself at the call site; this renders the human explanation.
   */
  error?: string;
  children: ReactNode;
}) => (
  // The wrapping <label> associates the field name programmatically without threading ids — a
  // control inside a label IS labelled by it.
  <label className="block">
    <span className="mb-1.5 block text-sm font-medium text-content">{label}</span>
    {children}
    {error ? (
      <span role="alert" className="mt-1 flex items-center gap-1 text-xs font-medium text-danger">
        <span aria-hidden="true">⚠</span>
        {error}
      </span>
    ) : (
      hint && <span className="mt-1 block text-xs text-content-subtle">{hint}</span>
    )}
  </label>
);

/* ---------------------------------------------------------------- workflow */

/**
 * The step rail for a multi-step flow (document review, CSV mapping, three-way match). Numbering is
 * load-bearing here rather than decorative — these are genuine sequences where order carries
 * information the user needs, and being able to see how many steps remain without scrolling is the
 * whole point.
 */
export const StepRail = ({
  steps,
  current,
}: {
  steps: string[];
  current: number;
}) => (
  <nav aria-label="Progress" className="mb-6 border-b border-border">
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 pb-3">
      {steps.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'todo';
        return (
          <li key={step} className="flex items-center gap-1">
            <span
              className={cx(
                'inline-flex items-center gap-2 rounded-control px-2.5 py-1 text-sm',
                state === 'current' && 'bg-accent-soft font-semibold text-content',
                state === 'done' && 'text-content-muted',
                state === 'todo' && 'text-content-subtle'
              )}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span
                className={cx(
                  'inline-flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                  state === 'current' && 'bg-accent text-accent-content',
                  state === 'done' && 'bg-positive-soft text-positive',
                  state === 'todo' && 'border border-border-strong text-content-subtle'
                )}
              >
                {state === 'done' ? '✓' : index + 1}
              </span>
              {step}
            </span>
            {index < steps.length - 1 && (
              <span aria-hidden="true" className="text-content-subtle">
                ·
              </span>
            )}
          </li>
        );
      })}
    </ol>
  </nav>
);

/** The pinned action footer for a multi-step flow. Primary action right-aligned, always reachable without scrolling. */
export const WorkflowFooter = ({ children }: { children: ReactNode }) => (
  <div className="sticky bottom-0 z-10 mt-6 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-raised/90 px-1 py-3 backdrop-blur">
    {children}
  </div>
);
