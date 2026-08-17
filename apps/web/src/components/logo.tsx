import { cx } from './ui';

/**
 * The Vyapaar mark: four bars on a shared baseline, the third rising clear in brass.
 *
 * It states the product in one shape — a row of figures where most sit quiet and one demands
 * attention. That is the exception feed, the dashboard's headline row, and the reason the whole
 * thing exists. The raised bar takes `--color-accent` because that is the rule the entire interface
 * runs on: brass marks the thing to look at, and nothing else is brass.
 *
 * Proportions are deliberate rather than arbitrary. Bars are 5 units wide on an 8-unit pitch, so
 * the gap is always 3 — tight enough to read as one object, open enough to stay distinct at 16px.
 * The resting bars step 8/11/9 in height (uneven, so it reads as real data rather than a decorative
 * ramp) and the accent bar runs to 24, more than double the tallest neighbour, so it wins the eye
 * at any size. Radius is half the bar width, giving a true stadium cap that survives downscaling
 * where a square corner would alias.
 */
export const LogoMark = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 40 40" role="img" aria-label="Vyapaar" className={cx('block', className)} fill="none">
    <rect x="6" y="24" width="5" height="8" rx="2.5" fill="currentColor" opacity="0.85" />
    <rect x="14" y="21" width="5" height="11" rx="2.5" fill="currentColor" opacity="0.85" />
    <rect x="22" y="8" width="5" height="24" rx="2.5" fill="var(--color-accent)" />
    <rect x="30" y="23" width="5" height="9" rx="2.5" fill="currentColor" opacity="0.85" />
  </svg>
);

/**
 * Mark + wordmark. The wordmark deliberately does nothing clever — the same face as the rest of the
 * interface, semibold, slightly tightened — because the mark already carries the personality and
 * two competing ideas in one lockup is one too many.
 */
export const Logo = ({
  className,
  markClassName,
  showWordmark = true,
}: {
  className?: string;
  markClassName?: string;
  showWordmark?: boolean;
}) => (
  <span className={cx('inline-flex items-center gap-2', className)}>
    <LogoMark className={cx('size-7 shrink-0 text-content', markClassName)} />
    {showWordmark && (
      <span className="text-[15px] font-semibold tracking-[-0.01em] text-content">Vyapaar</span>
    )}
  </span>
);
