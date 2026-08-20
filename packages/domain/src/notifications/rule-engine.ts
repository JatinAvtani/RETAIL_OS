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
  | 'stocktake_variance';

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
