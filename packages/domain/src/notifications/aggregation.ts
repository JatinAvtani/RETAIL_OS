import { Decimal } from 'decimal.js';
import type { AlertSeverity } from './rule-engine.js';

/**
 * The worked example that motivates this module: "5 expiring lots -> 1 notification, not 5." An
 * aggregation group is a set of individual rule firings (e.g. every lot expiring at the same
 * store on the same local date) that must collapse into ONE `notifications` row rather than one
 * per firing —
 * distinct from dedup (which prevents the SAME condition re-firing a NEW row on repeated
 * evaluation; this collapses MULTIPLE DIFFERENT conditions sharing one group into one row from
 * the start). Pure (I1): the caller resolves the real per-item facts (via `evaluateLotExpiring`
 * etc.) and this function only decides how to present them together — never re-fires a metric or
 * queries anything.
 */
export interface AggregationItem {
  /** A short, human-readable label for one item in the group — e.g. "12kg cream (lot #4821)". */
  label: string;
  /** Real dollar impact for this one item, or `null` when the rule type has none (I7 — never synthesized). */
  dollarImpact: Decimal | null;
  severity: AlertSeverity;
}

export interface AggregatedNotificationContent {
  title: string;
  body: string;
  /** The sum of every item's real dollarImpact, or `null` if NONE of the items carry one — never a partial sum silently treated as the whole. */
  totalDollarImpact: Decimal | null;
  /** The highest severity among the group's items — an aggregated notification is never quieter than its loudest constituent. */
  severity: AlertSeverity;
  itemCount: number;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { INFO: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

/** The severity ordering used both for picking an aggregate's overall severity and for future feed sorting. */
export const compareSeverity = (a: AlertSeverity, b: AlertSeverity): number => SEVERITY_RANK[a] - SEVERITY_RANK[b];

const highestSeverity = (items: AggregationItem[]): AlertSeverity =>
  items.reduce<AlertSeverity>((max, item) => (compareSeverity(item.severity, max) > 0 ? item.severity : max), 'INFO');

/**
 * Combines every item sharing one aggregation group into a single notification's content.
 * `totalDollarImpact` sums real values only — if even one item's impact is `null` (a rule type
 * with no per-unit cost data, matching `evaluateStockBelowReorder`'s own `dollarImpact: null`),
 * the TOTAL still reflects the sum of whichever items DO carry a real figure, never silently
 * dropping to `null` for the whole group just because one member lacks a number — a real $220
 * total from 4 priced items is not "unknown" merely because a 5th item has no price data. Only
 * when NO item in the group has a real figure does the total itself become `null` (I7 — no
 * fabricated zero).
 *
 * Throws on an empty list — an aggregation group with zero items is a caller bug (nothing to
 * aggregate), not a "zero notifications" case; the caller decides whether to call this at all,
 * matching `evaluateStockBelowReorder`'s own "caller resolves real data first" discipline.
 */
export const aggregateNotificationContent = (
  items: AggregationItem[],
  formatTitle: (count: number, totalDollarImpact: Decimal | null) => string,
  formatBody: (items: AggregationItem[]) => string
): AggregatedNotificationContent => {
  if (items.length === 0) {
    throw new Error('aggregateNotificationContent called with an empty item list — nothing to aggregate.');
  }

  const pricedItems = items.filter((item): item is AggregationItem & { dollarImpact: Decimal } => item.dollarImpact !== null);
  const totalDollarImpact = pricedItems.length > 0 ? pricedItems.reduce((sum, item) => sum.plus(item.dollarImpact), new Decimal(0)) : null;

  return {
    title: formatTitle(items.length, totalDollarImpact),
    body: formatBody(items),
    totalDollarImpact,
    severity: highestSeverity(items),
    itemCount: items.length,
  };
};

/**
 * `lot_expiring`'s own real title/body shape, matching the target-output worked example
 * ("$340 at risk — 12kg cream and 8kg berries expire in 2 days"). A pure formatting function, not
 * a template the aggregation core hardcodes — different rule types will want different phrasing
 * (the daily briefing reuses this same aggregation core for its own exception ranking, by design).
 */
export const formatLotExpiringTitle = (count: number, totalDollarImpact: Decimal | null): string => {
  const impactPhrase = totalDollarImpact !== null ? `$${totalDollarImpact.toFixed(2)} at risk` : 'Stock at risk of expiring';
  return count === 1 ? impactPhrase : `${impactPhrase} — ${count} lots expiring`;
};

export const formatLotExpiringBody = (items: AggregationItem[]): string =>
  items.length === 1 ? `${items[0]!.label} is expiring soon.` : `${items.map((item) => item.label).join(', ')} are expiring soon.`;
