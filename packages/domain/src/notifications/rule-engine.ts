import { Decimal } from 'decimal.js';

/**
 * The pure evaluation core for the pipeline's first stage: "domain event -> rule evaluation
 * (per-tenant thresholds, sensible defaults) -> severity assignment." This module answers exactly
 * that question — given a rule's configured threshold and a real candidate fact already resolved
 * by the caller (a stock level vs. a reorder point, a lot's value at risk), decide whether it
 * fires and what severity — with no I/O (I1): the caller resolves real data from
 * `ParLevelRepository.findBelowReorderPointForStore`/`findExpiryQueue`/etc. and this function only
 * decides. Dedup-key/aggregation-group construction lives here too since the worked examples
 * (`expiry:{store}:{date}`, `price_change:{supplier}:{product}`) are pure string formatting, not
 * I/O — the dedup/aggregation module is the real caller deciding suppression-window policy around
 * this, not re-deriving the key format itself.
 */

export type AlertRuleType =
  | 'stock_below_reorder'
  | 'lot_expiring'
  | 'supplier_price_increase'
  | 'invoice_variance'
  | 'document_review_required'
  | 'po_awaiting_approval'
  | 'negative_stock'
  | 'unmapped_pos_items'
  | 'sales_anomaly'
  | 'margin_drop'
  | 'stocktake_variance'
  | 'daily_briefing';

export type AlertSeverity = 'INFO' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * Per-rule-type sensible defaults, matching the alert catalogue table exactly —
 * `notification_rules.severity` overrides this per tenant when a row exists; a tenant with no
 * configured rule still gets a real default rather than silence (`resolveEffectiveThreshold`
 * below is the function that actually applies this fallback).
 */
export const DEFAULT_SEVERITY_BY_RULE_TYPE: Record<AlertRuleType, AlertSeverity> = {
  stock_below_reorder: 'HIGH',
  lot_expiring: 'HIGH',
  supplier_price_increase: 'HIGH',
  invoice_variance: 'HIGH',
  document_review_required: 'MEDIUM',
  po_awaiting_approval: 'MEDIUM',
  negative_stock: 'MEDIUM',
  unmapped_pos_items: 'MEDIUM',
  sales_anomaly: 'MEDIUM',
  margin_drop: 'HIGH',
  stocktake_variance: 'HIGH',
  daily_briefing: 'INFO',
};

/**
 * "5 expiring lots produce 1 aggregated notification, not 5" — the dedup-key shape below is a
 * worked example, not a fixed literal, made real and testable. `date` is a store-LOCAL calendar
 * date string (`resolveLocalDate`, `packages/domain/src/time`), never a UTC one — the same
 * store-timezone discipline every other period boundary in this codebase already follows.
 */
export const buildExpiryDedupKey = (storeId: string, localDate: string): string => `expiry:${storeId}:${localDate}`;

/** A second worked example, verbatim: suppresses repeat price-change alerts for the same product. */
export const buildPriceChangeDedupKey = (supplierId: string, productId: string): string =>
  `price_change:${supplierId}:${productId}`;

/** One dedup key per (store, product, variant) below reorder — repeated evaluations while still below point update the same open notification, never re-fire as a new one. */
export const buildStockBelowReorderDedupKey = (storeId: string, productId: string, variantId: string): string =>
  `stock_below_reorder:${storeId}:${productId}:${variantId}`;

/** One dedup key per purchase order — a PO can only be "awaiting approval" once at a time; a later resubmission after a REJECT is a fresh SUBMIT, but the same open PO id never produces two concurrent open alerts. */
export const buildPoAwaitingApprovalDedupKey = (purchaseOrderId: string): string => `po_awaiting_approval:${purchaseOrderId}`;

/** One dedup key per invoice match — `match.variance_detected` fires once per completed three-way-match run, so the match id itself (not the document id) is the natural key: a re-run of matching on the same document produces a new match row and therefore a genuinely new key. */
export const buildInvoiceVarianceDedupKey = (invoiceMatchId: string): string => `invoice_variance:${invoiceMatchId}`;

/** One dedup key per (supplier, product) — mirrors `buildPriceChangeDedupKey` exactly (the worked example this codebase already committed to); kept as a distinct name so a caller reading `AlertRuleType` can find the key builder for `supplier_price_increase` without knowing it's the same string shape as the older example. */
export const buildSupplierPriceIncreaseDedupKey = (supplierId: string, productId: string): string =>
  buildPriceChangeDedupKey(supplierId, productId);

/** One dedup key per (store, product, variant) — mirrors `buildStockBelowReorderDedupKey`'s shape; negative stock and below-reorder are different conditions on the same (store, product, variant) triple, so they need distinct key namespaces, never colliding. */
export const buildNegativeStockDedupKey = (storeId: string, productId: string, variantId: string): string =>
  `negative_stock:${storeId}:${productId}:${variantId}`;

/**
 * One dedup key per (store, store-LOCAL date) — a retried/re-run briefing generation for the SAME
 * day updates the same notification row rather than creating a duplicate, while the NEXT real
 * calendar day always gets a genuinely fresh key (never re-opened, since `resolveDedupAction`
 * would UPDATE an existing open row sharing this key — the briefing scheduler always calls
 * `markResolved` on the prior day's notification before generating a new one, so "yesterday's
 * briefing" and "today's briefing" are always two distinct rows, not one that mutates forever).
 */
export const buildDailyBriefingDedupKey = (storeId: string, localDate: string): string =>
  `daily_briefing:${storeId}:${localDate}`;

export interface StockBelowReorderCandidate {
  quantityOnHand: Decimal;
  reorderPoint: Decimal;
}

export interface StockBelowReorderResult {
  fires: boolean;
  severity: AlertSeverity;
  dedupKey: string;
  /** Never a fabricated figure — this rule type has no per-unit cost input, so impact is null, matching the tiered-ranking precedent (see `packages/assistant/src/briefing.ts`): tier by whether a real amount exists, never synthesize one. */
  dollarImpact: null;
}

/**
 * `stock_below_reorder` — the literal condition, `quantity <= reorder_point`, matching
 * `ParLevelRepository.findBelowReorderPointForStore`'s exact SQL predicate so a rule fires on
 * precisely the same rows that repository method already surfaces (I2: not a second, independently
 * drifting definition of "below reorder").
 */
export const evaluateStockBelowReorder = (
  candidate: StockBelowReorderCandidate,
  context: { storeId: string; productId: string; variantId: string },
  severity: AlertSeverity = DEFAULT_SEVERITY_BY_RULE_TYPE.stock_below_reorder
): StockBelowReorderResult => ({
  fires: candidate.quantityOnHand.lessThanOrEqualTo(candidate.reorderPoint),
  severity,
  dedupKey: buildStockBelowReorderDedupKey(context.storeId, context.productId, context.variantId),
  dollarImpact: null,
});

export interface LotExpiringCandidate {
  valueAtRisk: Decimal;
  daysToExpiry: number;
}

export interface LotExpiringThreshold {
  /** "within N days" — no canonical default number is specified elsewhere; 3 days matches this codebase's own `findExpiryQueue` doc-comment framing of an actionable near-term window, distinct from the 30-day lookback that function uses for consumption smoothing (a different constant for a different purpose). */
  withinDays: number;
}

export const DEFAULT_LOT_EXPIRING_THRESHOLD: LotExpiringThreshold = { withinDays: 3 };

/**
 * The single real "large variance" bar for a stocktake line, shared by two callers that must agree
 * on the exact same number (I2): `packages/db`'s `StockCountService.approveCount` (requires a
 * `reasonCode` before approving any line at or above this magnitude) and `evaluateStocktakeVariance`
 * below (decides whether a just-submitted count is worth alerting on at all). Previously defined
 * twice — once in each file — which would have silently drifted the moment either number changed
 * without the other; now defined once, here, since `packages/domain` has no I/O dependency `packages/db`
 * can import from in the other direction.
 */
export const LARGE_VARIANCE_THRESHOLD = 0.1;

export interface LotExpiringResult {
  fires: boolean;
  severity: AlertSeverity;
  dedupKey: string;
  /** A real dollar figure — `findExpiryQueue` already computes `valueAtRisk` from real lot cost data, so this is never synthesized, only carried through. */
  dollarImpact: Decimal;
}

/**
 * `lot_expiring` — fires once a lot is within the configured window, aggregated per (store, local
 * date) so the "5 expiring lots -> 1 notification" example is the caller's default grouping key,
 * not a per-lot one. `findExpiryQueue` already only returns genuinely at-risk lots (real
 * consumption-cover logic, I7-safe); this function's `fires` is a strictly narrower day-window gate
 * on top of that, not a re-implementation of at-risk detection.
 */
export const evaluateLotExpiring = (
  candidate: LotExpiringCandidate,
  context: { storeId: string; localDate: string },
  threshold: LotExpiringThreshold = DEFAULT_LOT_EXPIRING_THRESHOLD,
  severity: AlertSeverity = DEFAULT_SEVERITY_BY_RULE_TYPE.lot_expiring
): LotExpiringResult => ({
  fires: candidate.daysToExpiry <= threshold.withinDays,
  severity,
  dedupKey: buildExpiryDedupKey(context.storeId, context.localDate),
  dollarImpact: candidate.valueAtRisk,
});

export interface PoAwaitingApprovalResult {
  fires: boolean;
  severity: AlertSeverity;
  dedupKey: string;
  dollarImpact: null;
}

/**
 * `po_awaiting_approval` — fires whenever a real `po.submitted` outbox event is observed. There is
 * no threshold to evaluate here (unlike `stock_below_reorder`'s quantity comparison): the PO state
 * machine (`applyPurchaseOrderTransition`, `packages/domain/src/purchasing/po-lifecycle.ts`) already
 * only allows `SUBMIT` from `DRAFT`, and only ever emits `po.submitted` for a transition it accepted
 * — the event itself IS the fact "this PO is now, genuinely, `PENDING_APPROVAL`." This function
 * exists (rather than the caller skipping straight to a notification) purely so the dedup-key
 * construction and the `fires` contract stay uniform with every other rule type the processor
 * consumes.
 */
export const evaluatePoAwaitingApproval = (
  context: { purchaseOrderId: string },
  severity: AlertSeverity = DEFAULT_SEVERITY_BY_RULE_TYPE.po_awaiting_approval
): PoAwaitingApprovalResult => ({
  fires: true,
  severity,
  dedupKey: buildPoAwaitingApprovalDedupKey(context.purchaseOrderId),
  dollarImpact: null,
});

export interface InvoiceVarianceResult {
  fires: boolean;
  severity: AlertSeverity;
  dedupKey: string;
  dollarImpact: null;
}

/**
 * `invoice_variance` — fires whenever `match.variance_detected` reports a `highestSeverity` above
 * `'NONE'` (`InvoiceMatchRepository.runMatchInTx` already computed this via `classifyLineMatch`/
 * `highestSeverity`, I2 — this function does not re-derive variance, only decides whether the
 * ALREADY-classified outcome is worth alerting on). A `CLEAN` match (`highestSeverity: 'NONE'`) is
 * not a variance at all, so it never fires — matching `runMatchInTx`'s own "clean vs. error" framing
 * one level up.
 */
export const evaluateInvoiceVariance = (
  candidate: { highestSeverity: VarianceSeverityInput },
  context: { invoiceMatchId: string },
  severity: AlertSeverity = DEFAULT_SEVERITY_BY_RULE_TYPE.invoice_variance
): InvoiceVarianceResult => ({
  fires: candidate.highestSeverity !== 'NONE',
  severity,
  dedupKey: buildInvoiceVarianceDedupKey(context.invoiceMatchId),
  dollarImpact: null,
});

/** The subset of `VarianceSeverity` (`packages/domain/src/purchasing/three-way-match.ts`) this evaluator cares about — kept as a local narrow type rather than importing the purchasing module, since `rule-engine.ts` has no I/O and no other dependency on the purchasing domain today. */
export type VarianceSeverityInput = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface SupplierPriceIncreaseCandidate {
  /** Real annualized dollar impact already computed by `detectPriceChange` — `null` when no trailing receiving history exists (I7), never synthesized here. */
  annualizedImpact: Decimal | null;
}

export interface SupplierPriceIncreaseResult {
  fires: boolean;
  severity: AlertSeverity;
  dedupKey: string;
  dollarImpact: Decimal | null;
}

/**
 * `supplier_price_increase` — fires whenever a real `supplier.price_changed` outbox event is
 * observed. `PostingService.postLineInTx` (`packages/db/src/repositories/posting-service.ts`) only
 * emits that event AFTER `detectPriceChange` already confirmed the change crosses
 * `DEFAULT_PRICE_CHANGE_THRESHOLD_PERCENT` — the same "the event IS the fact" reasoning as
 * `evaluatePoAwaitingApproval` above, so this function adds no second threshold check of its own
 * (I2: not a second, independently-drifting definition of "significant price change").
 */
export const evaluateSupplierPriceIncrease = (
  candidate: SupplierPriceIncreaseCandidate,
  context: { supplierId: string; productId: string },
  severity: AlertSeverity = DEFAULT_SEVERITY_BY_RULE_TYPE.supplier_price_increase
): SupplierPriceIncreaseResult => ({
  fires: true,
  severity,
  dedupKey: buildSupplierPriceIncreaseDedupKey(context.supplierId, context.productId),
  dollarImpact: candidate.annualizedImpact,
});

export interface NegativeStockCandidate {
  quantityOnHand: Decimal;
}

export interface NegativeStockResult {
  fires: boolean;
  severity: AlertSeverity;
  dedupKey: string;
  /** Negative stock has no per-unit cost input at the point of detection (`findNegativeStock` reports quantity only, not a lot cost) — `null`, matching `evaluateStockBelowReorder`'s own precedent rather than guessing a valuation. */
  dollarImpact: null;
}

/**
 * `negative_stock` — the literal condition `quantity < 0`, matching `findNegativeStock`'s own exact
 * SQL predicate (`packages/db/src/negative-stock.ts`) so this fires on precisely the same rows that
 * function already surfaces (I2). Confirmed there as "a signal, not an error — alert; don't block":
 * this evaluator is the alerting half that function's own doc comment left for "a future worker job."
 */
export const evaluateNegativeStock = (
  candidate: NegativeStockCandidate,
  context: { storeId: string; productId: string; variantId: string },
  severity: AlertSeverity = DEFAULT_SEVERITY_BY_RULE_TYPE.negative_stock
): NegativeStockResult => ({
  fires: candidate.quantityOnHand.lessThan(0),
  severity,
  dedupKey: buildNegativeStockDedupKey(context.storeId, context.productId, context.variantId),
  dollarImpact: null,
});

/** One dedup key per (store, store-local anomalous date) — a genuine z-score outlier on a specific real calendar day, mirroring `buildDailyBriefingDedupKey`'s shape: re-running the sweep for the same window re-confirms the SAME open notification for a day still flagged, and the next real calendar day is always a distinct key, never reopening a stale one. */
export const buildSalesAnomalyDedupKey = (storeId: string, anomalousLocalDate: string): string =>
  `sales_anomaly:${storeId}:${anomalousLocalDate}`;

export interface SalesAnomalyCandidate {
  /** One already-flagged day from `computeSalesAnomalies` (`packages/metrics/src/anomaly/anomaly.ts`) — a real z-score outlier, never re-derived here (I2: the statistical decomposition lives in exactly one place). */
  date: string;
  /** The day's own real, RAW revenue — deliberately NOT `FlaggedPoint.value` (the decomposition's residual, `actual - trend - seasonal`): a residual is the correct statistical magnitude but not a figure a human reads as "today's revenue," so the caller looks up the real actual value separately (the same `sales_transactions` data the metric itself reads, I2) and passes it here. */
  actualRevenue: string;
  zScore: string;
}

export interface SalesAnomalyResult {
  fires: boolean;
  severity: AlertSeverity;
  dedupKey: string;
  /** The day's own real, raw revenue — never the statistical residual, never fabricated (I7). */
  dollarImpact: Decimal;
}

/**
 * `sales_anomaly` — one evaluation call PER already-flagged day, not per sweep run: the metric
 * (`salesAnomalyMetric`, `packages/metrics`) already computed the real seasonal-decomposition
 * z-score test over the whole window and returned only the days that crossed `|z| > 2.5`; this
 * function has no threshold logic of its own; it always fires for a day the metric already
 * confirmed anomalous (I2 — one statistical decomposition, not a second one re-implemented here).
 */
export const evaluateSalesAnomaly = (
  candidate: SalesAnomalyCandidate,
  context: { storeId: string },
  severity: AlertSeverity = DEFAULT_SEVERITY_BY_RULE_TYPE.sales_anomaly
): SalesAnomalyResult => ({
  fires: true,
  severity,
  dedupKey: buildSalesAnomalyDedupKey(context.storeId, candidate.date),
  dollarImpact: new Decimal(candidate.actualRevenue),
});

/** One dedup key per stock count — a count is submitted exactly once (`submitCount` transitions `IN_PROGRESS -> SUBMITTED` and cannot be re-run), so unlike every other rule type here there is no later re-evaluation of the SAME key; this still matches the shared dedup-key convention so the processor's generic `resolveDedupAction` path works unchanged. */
export const buildStocktakeVarianceDedupKey = (stockCountId: string): string => `stocktake_variance:${stockCountId}`;

export interface StocktakeVarianceCandidate {
  /** The largest variance magnitude (`|counted - theoretical| / |theoretical|`) among the count's own lines — the SAME ratio `approveCount`'s `LARGE_VARIANCE_THRESHOLD` gate already computes, never re-derived with a different formula (I2). `null` when every line's theoretical quantity was unknown at submission (I7 — no line to compare against, not a fabricated zero variance). */
  maxVarianceMagnitude: string | null;
  /** The real dollar value of whichever line carries the largest variance magnitude, or `null` when that line's variance value was itself unknown at submission (I7). */
  largestVarianceDollarValue: string | null;
}

export interface StocktakeVarianceResult {
  fires: boolean;
  severity: AlertSeverity;
  dedupKey: string;
  dollarImpact: Decimal | null;
}

/**
 * `stocktake_variance` — fires when a just-submitted count has at least one line whose variance
 * magnitude meets or exceeds `stock-count-service.ts`'s own `LARGE_VARIANCE_THRESHOLD` (0.1, the
 * exact bar `approveCount` already uses to require a reason code before approval) — the same
 * "worth a human's attention" line, not a second threshold invented here (I2). A count with no line
 * meeting that bar, or whose largest magnitude is unknown (no theoretical quantity was ever
 * snapshotted), never fires.
 */
export const evaluateStocktakeVariance = (
  candidate: StocktakeVarianceCandidate,
  context: { stockCountId: string },
  severity: AlertSeverity = DEFAULT_SEVERITY_BY_RULE_TYPE.stocktake_variance
): StocktakeVarianceResult => ({
  fires: candidate.maxVarianceMagnitude !== null && new Decimal(candidate.maxVarianceMagnitude).greaterThanOrEqualTo(LARGE_VARIANCE_THRESHOLD),
  severity,
  dedupKey: buildStocktakeVarianceDedupKey(context.stockCountId),
  dollarImpact: candidate.largestVarianceDollarValue !== null ? new Decimal(candidate.largestVarianceDollarValue).abs() : null,
});

/** One dedup key per (org, store) — an org-wide sweep re-evaluating the SAME store's unmapped backlog on a later tick must update the same open notification, never fire a fresh one per tick. A store with zero unmapped items simply never fires (see `evaluateUnmappedPosItems`), so this key's lifetime is exactly "unmapped items exist for this store, however many." */
export const buildUnmappedPosItemsDedupKey = (storeId: string): string => `unmapped_pos_items:${storeId}`;

export interface UnmappedPosItem {
  /** A short, human-readable label — e.g. "Iced Latte (Large)". */
  name: string;
  /** Real trailing revenue already attributed to this item while unmapped, or `null` when it has never sold (I7 — genuinely no sales signal, not a synthesized zero). `findUnmappedRankedByVolume`'s own COALESCE already makes a real, unambiguous `'0'` distinct from a missing value — this field stays `Decimal | null` only to preserve that distinction through to `AggregationItem`, matching every other rule type's own "no fabricated dollar figure" contract. */
  totalRevenue: Decimal | null;
}

export interface UnmappedPosItemsResult {
  fires: boolean;
  severity: AlertSeverity;
  dedupKey: string;
}

/**
 * `unmapped_pos_items` — fires whenever a store has at least one real POS catalog item
 * (`findUnmappedRankedByVolume`, `packages/db`) that has never been mapped to a `MenuItem`. No
 * threshold to configure (unlike `stock_below_reorder`'s reorder point): the mere EXISTENCE of an
 * unmapped item is itself the actionable fact — every sale against it is silently unattributed to
 * any recipe/ingredient consumption, corrupting theoretical COGS for as long as it stays unmapped.
 */
export const evaluateUnmappedPosItems = (
  candidateCount: number,
  context: { storeId: string },
  severity: AlertSeverity = DEFAULT_SEVERITY_BY_RULE_TYPE.unmapped_pos_items
): UnmappedPosItemsResult => ({
  fires: candidateCount > 0,
  severity,
  dedupKey: buildUnmappedPosItemsDedupKey(context.storeId),
});

/** One dedup key per (org, store) — matches `buildUnmappedPosItemsDedupKey`'s own reasoning: a later sweep tick re-evaluating the SAME store's review-required backlog must update the same open notification, never fire a fresh one per tick. */
export const buildDocumentReviewRequiredDedupKey = (storeId: string): string => `document_review_required:${storeId}`;

export interface DocumentReviewRequiredResult {
  fires: boolean;
  severity: AlertSeverity;
  dedupKey: string;
}

/**
 * `document_review_required` — fires whenever a store has at least one real document
 * (`findDocumentsReviewRequired`, `packages/db`) sitting at the real `REVIEW_REQUIRED` status
 * `decideDocumentRouting` already assigns when a document's own extraction confidence/validation
 * gates don't clear the auto-approval bar. No new "needs review" threshold is invented here (I2) —
 * this only reacts to a status the ingestion pipeline already computed. No dollar impact: an
 * unreviewed document has no known cost until a human resolves it (I7 — never a fabricated figure).
 */
export const evaluateDocumentReviewRequired = (
  candidateCount: number,
  context: { storeId: string },
  severity: AlertSeverity = DEFAULT_SEVERITY_BY_RULE_TYPE.document_review_required
): DocumentReviewRequiredResult => ({
  fires: candidateCount > 0,
  severity,
  dedupKey: buildDocumentReviewRequiredDedupKey(context.storeId),
});

/** One dedup key per (store, store-local comparison-period-end date) — a re-run of the same day's sweep re-confirms the SAME open notification while the drop persists; the next real calendar day is always a distinct key, matching `buildSalesAnomalyDedupKey`'s own shape. */
export const buildMarginDropDedupKey = (storeId: string, comparisonPeriodEndLocalDate: string): string =>
  `margin_drop:${storeId}:${comparisonPeriodEndLocalDate}`;

export interface MarginDropThreshold {
  /** Minimum percentage-POINT drop (comparison period's contribution-margin % minus base period's) to fire — e.g. 5 means "margin % fell by 5 points or more." Not a relative/ratio drop: a 20%-of-20% halving and a 45%-to-40% five-point slip are very different operational events, and percentage points are the unit `contribution_margin_percentage` itself already reports in. */
  minPercentagePointDrop: number;
}

/** 5 percentage points — a real, noticeable slip (e.g. 35% -> 30%) rather than ordinary day-to-day noise; no canonical default exists elsewhere in the spec, chosen to match `LotExpiringThreshold`'s own "one sensible number, tenant-overridable" precedent rather than a stricter/looser guess. */
export const DEFAULT_MARGIN_DROP_THRESHOLD: MarginDropThreshold = { minPercentagePointDrop: 5 };

export interface MarginDropCandidate {
  /** `contribution_margin_percentage` for the base (earlier) period, as a plain percentage number (e.g. 35.2), or `null` when unknown (I7 — no comparison is possible without a real base figure). */
  basePercentage: string | null;
  /** Same metric for the comparison (later, "now") period. */
  comparisonPercentage: string | null;
  /** The comparison period's real dollar contribution-margin change vs. the base period, from `margin_attribution`'s own `value` (I2 — never a second, independently-computed dollar figure). `null` when the attribution itself is `unknown`. */
  dollarChange: string | null;
}

export interface MarginDropResult {
  fires: boolean;
  severity: AlertSeverity;
  dedupKey: string;
  /** The real dollar contribution-margin change (always ≤ 0 when this fires) — never a fabricated figure; `null` when `margin_attribution` itself could not resolve a comparison (I7). */
  dollarImpact: Decimal | null;
}

/**
 * `margin_drop` — fires when a store's own contribution-margin percentage falls by at least the
 * configured threshold between two periods (I2: `contribution_margin_percentage` already computes
 * both figures; this function only compares two ALREADY-computed values, never re-derives margin
 * itself). `null` on either side means the period genuinely has no computable margin (no sales, or
 * every item's cost unknown) — this never fires on an unknown, since "unknown compared to X" is not
 * itself a drop (I7: silence, not a fabricated comparison).
 */
export const evaluateMarginDrop = (
  candidate: MarginDropCandidate,
  context: { storeId: string; comparisonPeriodEndLocalDate: string },
  threshold: MarginDropThreshold = DEFAULT_MARGIN_DROP_THRESHOLD,
  severity: AlertSeverity = DEFAULT_SEVERITY_BY_RULE_TYPE.margin_drop
): MarginDropResult => {
  const dedupKey = buildMarginDropDedupKey(context.storeId, context.comparisonPeriodEndLocalDate);
  if (candidate.basePercentage === null || candidate.comparisonPercentage === null) {
    return { fires: false, severity, dedupKey, dollarImpact: null };
  }

  const drop = new Decimal(candidate.basePercentage).minus(candidate.comparisonPercentage);
  const fires = drop.greaterThanOrEqualTo(threshold.minPercentagePointDrop);

  return {
    fires,
    severity,
    dedupKey,
    dollarImpact: candidate.dollarChange !== null ? new Decimal(candidate.dollarChange) : null,
  };
};

/**
 * Resolves a rule-type's effective severity: the tenant's configured `notification_rules.severity`
 * when a row exists and is enabled, otherwise the catalogue default. The caller (the rule
 * evaluation processor) is responsible for the "no rule row at all" vs. "row exists but disabled"
 * distinction — this function only implements the fallback itself, given whatever the caller
 * already resolved.
 */
export const resolveEffectiveSeverity = (
  ruleType: AlertRuleType,
  configuredSeverity: AlertSeverity | null
): AlertSeverity => configuredSeverity ?? DEFAULT_SEVERITY_BY_RULE_TYPE[ruleType];

export interface CandidateRule {
  id: string;
  storeId: string | null;
  severity: string;
  threshold: unknown;
  recipientRoles: string[];
  channels: string[];
}

/**
 * "Per-tenant thresholds + defaults." Given every ENABLED rule row of a given type a tenant has
 * configured (`NotificationRuleRepository.findEnabledByType`, unfiltered by store), picks the one
 * that actually applies to a specific store: a store-specific row (`storeId` matching) wins over
 * an org-wide row (`storeId: null`), matching `notification_rules.storeId`'s own documented
 * nullability ("null means applies to every store in the org"). Returns `null` when the tenant has
 * configured nothing for this (store, rule type) — the caller then falls back to
 * `DEFAULT_SEVERITY_BY_RULE_TYPE` and each rule's own hardcoded default threshold (e.g.
 * `DEFAULT_LOT_EXPIRING_THRESHOLD`), never silently skipping evaluation just because no row exists
 * — "sensible defaults", not "no alert without configuration".
 *
 * A pure function over an already-fetched candidate list — no I/O here, matching this module's own
 * discipline; the repository call that produces the candidate list is the caller's job.
 */
export const resolveApplicableRule = (candidates: CandidateRule[], storeId: string): CandidateRule | null => {
  const storeSpecific = candidates.find((rule) => rule.storeId === storeId);
  if (storeSpecific) return storeSpecific;
  const orgWide = candidates.find((rule) => rule.storeId === null);
  return orgWide ?? null;
};
