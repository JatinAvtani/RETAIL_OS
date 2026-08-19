import { Decimal } from 'decimal.js';

/**
 * "only measured events, no invented weights in MVP."
 * Every function here is pure — given already-fetched `supplier_performance_events` rows (I2's own
 * precedent, matching `computeExtractionAutoApprovalRate`: the router/repository fetches, this
 * package computes) — and returns ONE component metric. **No composite score is computed anywhere
 * in this file or exported from it** — the design is explicit that a single 0-100 weighted
 * figure is deferred to V2 and only introduced if the weights can be justified against a measured
 * outcome; publishing one now would be exactly the fabricated-scoring anti-pattern this project
 * exists to avoid. The scorecard presents these components side by side instead.
 *
 * `null` is returned whenever the relevant event type has zero occurrences in the window — an
 * empty period is a genuine "unknown," never a fabricated 0% (I7), matching every other rate metric
 * in this codebase (`computeExtractionAutoApprovalRate`'s own empty-input case).
 *
 * `effective unit cost` (the design's 7th named component: "landed unit cost incl. delivery
 * fees & credits") is deliberately NOT built here — this codebase has no representation anywhere
 * of delivery fees or credits on an invoice/receipt, so computing it would mean silently treating
 * "no fee data" as "zero fees," inflating the honesty of the figure (I7). A future task that adds
 * real fee/credit capture to the document pipeline is the correct place to build this component,
 * not a guess bolted onto this one.
 */

export interface SupplierPerformanceEventInput {
  eventType: string;
  expectedValue: string | null;
  actualValue: string | null;
  variance: string | null;
}

const countByType = (events: SupplierPerformanceEventInput[], eventType: string): number =>
  events.filter((e) => e.eventType === eventType).length;

/**
 * `Σ received_qty / Σ ordered_qty` (spec's own literal formula) — summed across every
 * FILL_COMPLETE/FILL_SHORT event's `expectedValue`/`actualValue` (ordered/received quantity per
 * delivery line), not averaged per-event, so one large short delivery correctly outweighs several
 * small complete ones rather than being diluted by event count.
 */
export const computeFillRate = (events: SupplierPerformanceEventInput[]): number | null => {
  const fillEvents = events.filter((e) => e.eventType === 'FILL_COMPLETE' || e.eventType === 'FILL_SHORT');
  if (fillEvents.length === 0) return null;
  let orderedTotal = new Decimal(0);
  let receivedTotal = new Decimal(0);
  for (const e of fillEvents) {
    if (e.expectedValue === null || e.actualValue === null) continue;
    orderedTotal = orderedTotal.plus(new Decimal(e.expectedValue));
    receivedTotal = receivedTotal.plus(new Decimal(e.actualValue));
  }
  if (orderedTotal.isZero()) return null;
  return receivedTotal.dividedBy(orderedTotal).toNumber();
};

/** `on_time_deliveries / total_deliveries` (spec's own literal formula) — one DELIVERY_ON_TIME/DELIVERY_LATE event per receipt. */
export const computeOnTimeRate = (events: SupplierPerformanceEventInput[]): number | null => {
  const onTime = countByType(events, 'DELIVERY_ON_TIME');
  const late = countByType(events, 'DELIVERY_LATE');
  const total = onTime + late;
  if (total === 0) return null;
  return onTime / total;
};

/**
 * `Σ(invoice_price − agreed_price) × qty` per spec's literal formula would need each PRICE_VARIANCE
 * event's own invoiced quantity, which this event type does not carry (it records unit prices, not
 * line quantity — `InvoiceMatchLine` already has that figure, but the event itself is a per-unit-
 * price measurement, matching the plan's own generic expected/actual/variance shape). This function
 * instead sums the real per-unit `variance` each PRICE_VARIANCE event already recorded — the total
 * per-unit price drift across every variance event in the window, in the invoice's own currency
 * units, still a real dollar figure drillable to its source events, just not quantity-weighted.
 */
export const computeTotalPriceVariance = (events: SupplierPerformanceEventInput[]): string | null => {
  const priceEvents = events.filter((e) => e.eventType === 'PRICE_VARIANCE' && e.variance !== null);
  if (priceEvents.length === 0) return null;
  const total = priceEvents.reduce((sum, e) => sum.plus(new Decimal(e.variance!)), new Decimal(0));
  return total.toFixed(4);
};

/** `clean_invoices / total_invoices` (spec's own literal formula) — one INVOICE_CLEAN/INVOICE_ERROR event per matched invoice document. */
export const computeInvoiceAccuracy = (events: SupplierPerformanceEventInput[]): number | null => {
  const clean = countByType(events, 'INVOICE_CLEAN');
  const error = countByType(events, 'INVOICE_ERROR');
  const total = clean + error;
  if (total === 0) return null;
  return clean / total;
};

/**
 * `rejected_qty / received_qty` (spec's own literal formula). The denominator is every FILL_COMPLETE/
 * FILL_SHORT event's real received quantity (`actualValue`) — the total quantity actually received
 * across the window, regardless of whether that particular line also carried a quality issue —
 * since a rate needs a real "out of how much" figure, not just a count of problem lines.
 */
export const computeQualityRejectRate = (events: SupplierPerformanceEventInput[]): number | null => {
  const fillEvents = events.filter((e) => e.eventType === 'FILL_COMPLETE' || e.eventType === 'FILL_SHORT');
  const receivedTotal = fillEvents.reduce((sum, e) => (e.actualValue !== null ? sum.plus(new Decimal(e.actualValue)) : sum), new Decimal(0));
  if (receivedTotal.isZero()) return null;

  const rejectEvents = events.filter((e) => e.eventType === 'QUALITY_REJECT' && e.actualValue !== null);
  const rejectedTotal = rejectEvents.reduce((sum, e) => sum.plus(new Decimal(e.actualValue!)), new Decimal(0));

  return rejectedTotal.dividedBy(receivedTotal).toNumber();
};

/** All four rate/dollar components together — the real read path earlier work's scorecard uses, one call per supplier per window. Each field independently `null` when its own underlying events don't exist (I7) — never a partial object standing in for a fuller one. */
export interface SupplierPerformanceComponents {
  fillRate: number | null;
  onTimeRate: number | null;
  totalPriceVariance: string | null;
  invoiceAccuracy: number | null;
  qualityRejectRate: number | null;
}

export const computeSupplierPerformanceComponents = (events: SupplierPerformanceEventInput[]): SupplierPerformanceComponents => ({
  fillRate: computeFillRate(events),
  onTimeRate: computeOnTimeRate(events),
  totalPriceVariance: computeTotalPriceVariance(events),
  invoiceAccuracy: computeInvoiceAccuracy(events),
  qualityRejectRate: computeQualityRejectRate(events),
});

/**
 * the plan — the
 * one real gap between earlier work's already-built scorecard (a single-window snapshot) and the plan's
 * literal wording. settled deliberately: a real period-over-period
 * comparison (current window vs. the immediately-preceding EQUAL-length window), not a bucketed
 * time series — reuses the exact same 5 compute functions above over two already-fetched event
 * lists, no new domain logic.
 *
 * `direction` is `null` whenever EITHER window's own value is `null` — a trend needs two real
 * numbers to compare; comparing a real value against "unknown" would either hide the fact that half
 * the comparison is missing or fabricate a fictitious flat/up/down verdict from an absent baseline
 * (I7). `'flat'` requires an EXACT equal comparison (both numeric components and the decimal-string
 * dollar figure), never a fuzzy "close enough" band — the caller's own UI is responsible for any
 * rounding/display tolerance, this function never rounds first and calls the result equal.
 */
export type TrendDirection = 'up' | 'down' | 'flat';

export interface ComponentTrend<T> {
  current: T;
  previous: T;
  direction: TrendDirection | null;
}

const numericTrend = (current: number | null, previous: number | null): TrendDirection | null => {
  if (current === null || previous === null) return null;
  if (current > previous) return 'up';
  if (current < previous) return 'down';
  return 'flat';
};

const decimalStringTrend = (current: string | null, previous: string | null): TrendDirection | null => {
  if (current === null || previous === null) return null;
  const cmp = new Decimal(current).comparedTo(new Decimal(previous));
  if (cmp > 0) return 'up';
  if (cmp < 0) return 'down';
  return 'flat';
};

export interface SupplierPerformanceComponentsWithTrend {
  fillRate: ComponentTrend<number | null>;
  onTimeRate: ComponentTrend<number | null>;
  totalPriceVariance: ComponentTrend<string | null>;
  invoiceAccuracy: ComponentTrend<number | null>;
  qualityRejectRate: ComponentTrend<number | null>;
}

export const computeSupplierPerformanceTrend = (
  currentWindowEvents: SupplierPerformanceEventInput[],
  previousWindowEvents: SupplierPerformanceEventInput[]
): SupplierPerformanceComponentsWithTrend => {
  const current = computeSupplierPerformanceComponents(currentWindowEvents);
  const previous = computeSupplierPerformanceComponents(previousWindowEvents);

  return {
    fillRate: { current: current.fillRate, previous: previous.fillRate, direction: numericTrend(current.fillRate, previous.fillRate) },
    onTimeRate: { current: current.onTimeRate, previous: previous.onTimeRate, direction: numericTrend(current.onTimeRate, previous.onTimeRate) },
    totalPriceVariance: {
      current: current.totalPriceVariance,
      previous: previous.totalPriceVariance,
      direction: decimalStringTrend(current.totalPriceVariance, previous.totalPriceVariance),
    },
    invoiceAccuracy: { current: current.invoiceAccuracy, previous: previous.invoiceAccuracy, direction: numericTrend(current.invoiceAccuracy, previous.invoiceAccuracy) },
    qualityRejectRate: {
      current: current.qualityRejectRate,
      previous: previous.qualityRejectRate,
      direction: numericTrend(current.qualityRejectRate, previous.qualityRejectRate),
    },
  };
};
