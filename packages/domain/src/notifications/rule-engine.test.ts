import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  buildDailyBriefingDedupKey,
  buildExpiryDedupKey,
  buildMarginDropDedupKey,
  buildPriceChangeDedupKey,
  buildSalesAnomalyDedupKey,
  buildStockBelowReorderDedupKey,
  buildUnmappedPosItemsDedupKey,
  buildDocumentReviewRequiredDedupKey,
  buildStocktakeVarianceDedupKey,
  DEFAULT_LOT_EXPIRING_THRESHOLD,
  DEFAULT_MARGIN_DROP_THRESHOLD,
  DEFAULT_SEVERITY_BY_RULE_TYPE,
  evaluateDocumentReviewRequired,
  evaluateLotExpiring,
  evaluateMarginDrop,
  evaluateSalesAnomaly,
  evaluateStockBelowReorder,
  evaluateStocktakeVariance,
  evaluateUnmappedPosItems,
  resolveApplicableRule,
  resolveEffectiveSeverity,
  type CandidateRule,
} from './rule-engine';

describe('evaluateStockBelowReorder', () => {
  it('fires when quantity on hand is strictly below the reorder point', () => {
    const result = evaluateStockBelowReorder(
      { quantityOnHand: new Decimal('3'), reorderPoint: new Decimal('5') },
      { storeId: 'store-1', productId: 'product-1', variantId: 'variant-1' }
    );
    expect(result.fires).toBe(true);
    expect(result.severity).toBe('HIGH');
    expect(result.dedupKey).toBe('stock_below_reorder:store-1:product-1:variant-1');
    expect(result.dollarImpact).toBeNull();
  });

  it('fires when quantity on hand exactly equals the reorder point — matching ParLevelRepository\'s own <= predicate', () => {
    const result = evaluateStockBelowReorder(
      { quantityOnHand: new Decimal('5'), reorderPoint: new Decimal('5') },
      { storeId: 'store-1', productId: 'product-1', variantId: 'variant-1' }
    );
    expect(result.fires).toBe(true);
  });

  it('does not fire when quantity on hand is above the reorder point', () => {
    const result = evaluateStockBelowReorder(
      { quantityOnHand: new Decimal('10'), reorderPoint: new Decimal('5') },
      { storeId: 'store-1', productId: 'product-1', variantId: 'variant-1' }
    );
    expect(result.fires).toBe(false);
  });

  it('a tenant-configured severity overrides the default', () => {
    const result = evaluateStockBelowReorder(
      { quantityOnHand: new Decimal('1'), reorderPoint: new Decimal('5') },
      { storeId: 'store-1', productId: 'product-1', variantId: 'variant-1' },
      'CRITICAL'
    );
    expect(result.severity).toBe('CRITICAL');
  });

  it('the dedup key is stable across repeated evaluations of the same (store, product, variant) — the mechanism dedup/aggregation needs to update rather than re-fire', () => {
    const first = evaluateStockBelowReorder(
      { quantityOnHand: new Decimal('4'), reorderPoint: new Decimal('5') },
      { storeId: 'store-1', productId: 'product-1', variantId: 'variant-1' }
    );
    const second = evaluateStockBelowReorder(
      { quantityOnHand: new Decimal('2'), reorderPoint: new Decimal('5') },
      { storeId: 'store-1', productId: 'product-1', variantId: 'variant-1' }
    );
    expect(first.dedupKey).toBe(second.dedupKey);
  });
});

describe('evaluateLotExpiring', () => {
  it('fires when days to expiry is within the default 3-day window', () => {
    const result = evaluateLotExpiring(
      { valueAtRisk: new Decimal('340.00'), daysToExpiry: 2 },
      { storeId: 'store-1', localDate: '2026-08-19' }
    );
    expect(result.fires).toBe(true);
    expect(result.severity).toBe('HIGH');
    expect(result.dollarImpact.toString()).toBe('340');
  });

  it('fires exactly at the threshold boundary', () => {
    const result = evaluateLotExpiring(
      { valueAtRisk: new Decimal('10'), daysToExpiry: DEFAULT_LOT_EXPIRING_THRESHOLD.withinDays },
      { storeId: 'store-1', localDate: '2026-08-19' }
    );
    expect(result.fires).toBe(true);
  });

  it('does not fire when days to expiry is beyond the window', () => {
    const result = evaluateLotExpiring(
      { valueAtRisk: new Decimal('340.00'), daysToExpiry: 10 },
      { storeId: 'store-1', localDate: '2026-08-19' }
    );
    expect(result.fires).toBe(false);
  });

  it('a custom threshold widens or narrows the firing window', () => {
    const result = evaluateLotExpiring(
      { valueAtRisk: new Decimal('50'), daysToExpiry: 5 },
      { storeId: 'store-1', localDate: '2026-08-19' },
      { withinDays: 7 }
    );
    expect(result.fires).toBe(true);
  });

  it('every candidate on the SAME store and local date collapses to one dedup key — the "5 expiring lots -> 1 notification" example', () => {
    const a = evaluateLotExpiring({ valueAtRisk: new Decimal('100'), daysToExpiry: 1 }, { storeId: 'store-1', localDate: '2026-08-19' });
    const b = evaluateLotExpiring({ valueAtRisk: new Decimal('40'), daysToExpiry: 2 }, { storeId: 'store-1', localDate: '2026-08-19' });
    expect(a.dedupKey).toBe(b.dedupKey);
  });

  it('a different local date produces a different dedup key — each day\'s expiries are their own aggregation group', () => {
    const day1 = evaluateLotExpiring({ valueAtRisk: new Decimal('100'), daysToExpiry: 1 }, { storeId: 'store-1', localDate: '2026-08-19' });
    const day2 = evaluateLotExpiring({ valueAtRisk: new Decimal('100'), daysToExpiry: 1 }, { storeId: 'store-1', localDate: '2026-08-20' });
    expect(day1.dedupKey).not.toBe(day2.dedupKey);
  });

  it('dollarImpact carries the real valueAtRisk through unchanged, never recomputed', () => {
    const result = evaluateLotExpiring(
      { valueAtRisk: new Decimal('123.4567'), daysToExpiry: 1 },
      { storeId: 'store-1', localDate: '2026-08-19' }
    );
    expect(result.dollarImpact.toString()).toBe('123.4567');
  });
});

describe('evaluateSalesAnomaly', () => {
  it('always fires — the metric already confirmed the day is a real statistical outlier before this is ever called (I2: one decomposition, not a second threshold check)', () => {
    const result = evaluateSalesAnomaly({ date: '2026-08-19', actualRevenue: '1234.5600', zScore: '3.1' }, { storeId: 'store-1' });
    expect(result.fires).toBe(true);
  });

  it('dollarImpact carries the real flagged revenue value through unchanged, never a fabricated impact figure', () => {
    const result = evaluateSalesAnomaly({ date: '2026-08-19', actualRevenue: '1234.5600', zScore: '3.1' }, { storeId: 'store-1' });
    expect(result.dollarImpact.toString()).toBe('1234.56');
  });

  it('two different flagged days at the SAME store produce two DISTINCT dedup keys — each anomalous day is its own notification, never collapsed', () => {
    const day1 = evaluateSalesAnomaly({ date: '2026-08-19', actualRevenue: '1000', zScore: '3.0' }, { storeId: 'store-1' });
    const day2 = evaluateSalesAnomaly({ date: '2026-08-20', actualRevenue: '1000', zScore: '3.0' }, { storeId: 'store-1' });
    expect(day1.dedupKey).not.toBe(day2.dedupKey);
  });

  it('the SAME flagged day at the SAME store re-evaluated (e.g. a re-run sweep) produces the SAME dedup key — updates, never duplicates', () => {
    const first = evaluateSalesAnomaly({ date: '2026-08-19', actualRevenue: '1000', zScore: '3.0' }, { storeId: 'store-1' });
    const second = evaluateSalesAnomaly({ date: '2026-08-19', actualRevenue: '1500', zScore: '3.8' }, { storeId: 'store-1' });
    expect(first.dedupKey).toBe(second.dedupKey);
  });

  it('falls back to the catalogue default severity when the caller supplies none', () => {
    const result = evaluateSalesAnomaly({ date: '2026-08-19', actualRevenue: '1000', zScore: '3.0' }, { storeId: 'store-1' });
    expect(result.severity).toBe(DEFAULT_SEVERITY_BY_RULE_TYPE.sales_anomaly);
  });
});

describe('evaluateMarginDrop', () => {
  it('fires when the percentage-point drop meets the default threshold', () => {
    const result = evaluateMarginDrop(
      { basePercentage: '35.0', comparisonPercentage: '30.0', dollarChange: '-450.0000' },
      { storeId: 'store-1', comparisonPeriodEndLocalDate: '2026-08-19' }
    );
    expect(result.fires).toBe(true);
  });

  it('does not fire on a drop smaller than the threshold', () => {
    const result = evaluateMarginDrop(
      { basePercentage: '35.0', comparisonPercentage: '32.0', dollarChange: '-100.0000' },
      { storeId: 'store-1', comparisonPeriodEndLocalDate: '2026-08-19' }
    );
    expect(result.fires).toBe(false);
  });

  it('does not fire when margin IMPROVED between periods', () => {
    const result = evaluateMarginDrop(
      { basePercentage: '30.0', comparisonPercentage: '35.0', dollarChange: '450.0000' },
      { storeId: 'store-1', comparisonPeriodEndLocalDate: '2026-08-19' }
    );
    expect(result.fires).toBe(false);
  });

  it('never fires when either percentage is unknown — silence, not a fabricated comparison (I7)', () => {
    const baseUnknown = evaluateMarginDrop(
      { basePercentage: null, comparisonPercentage: '30.0', dollarChange: null },
      { storeId: 'store-1', comparisonPeriodEndLocalDate: '2026-08-19' }
    );
    expect(baseUnknown.fires).toBe(false);
    expect(baseUnknown.dollarImpact).toBeNull();

    const comparisonUnknown = evaluateMarginDrop(
      { basePercentage: '35.0', comparisonPercentage: null, dollarChange: null },
      { storeId: 'store-1', comparisonPeriodEndLocalDate: '2026-08-19' }
    );
    expect(comparisonUnknown.fires).toBe(false);
  });

  it('respects a tenant-configured threshold override', () => {
    const strict = evaluateMarginDrop(
      { basePercentage: '35.0', comparisonPercentage: '33.0', dollarChange: '-100.0000' },
      { storeId: 'store-1', comparisonPeriodEndLocalDate: '2026-08-19' },
      { minPercentagePointDrop: 1 }
    );
    expect(strict.fires).toBe(true);

    const lenient = evaluateMarginDrop(
      { basePercentage: '35.0', comparisonPercentage: '33.0', dollarChange: '-100.0000' },
      { storeId: 'store-1', comparisonPeriodEndLocalDate: '2026-08-19' },
      { minPercentagePointDrop: 10 }
    );
    expect(lenient.fires).toBe(false);
  });

  it('dollarImpact carries the real margin_attribution change through unchanged, never re-derived', () => {
    const result = evaluateMarginDrop(
      { basePercentage: '35.0', comparisonPercentage: '30.0', dollarChange: '-450.1234' },
      { storeId: 'store-1', comparisonPeriodEndLocalDate: '2026-08-19' }
    );
    expect(result.dollarImpact?.toString()).toBe('-450.1234');
  });

  it('two different comparison-period-end dates at the SAME store produce two DISTINCT dedup keys', () => {
    const day1 = evaluateMarginDrop(
      { basePercentage: '35.0', comparisonPercentage: '30.0', dollarChange: '-450.0000' },
      { storeId: 'store-1', comparisonPeriodEndLocalDate: '2026-08-19' }
    );
    const day2 = evaluateMarginDrop(
      { basePercentage: '35.0', comparisonPercentage: '30.0', dollarChange: '-450.0000' },
      { storeId: 'store-1', comparisonPeriodEndLocalDate: '2026-08-20' }
    );
    expect(day1.dedupKey).not.toBe(day2.dedupKey);
    expect(day1.dedupKey).toBe(buildMarginDropDedupKey('store-1', '2026-08-19'));
  });

  it('falls back to the catalogue default severity and threshold when the caller supplies none', () => {
    const result = evaluateMarginDrop(
      { basePercentage: '35.0', comparisonPercentage: '30.0', dollarChange: '-450.0000' },
      { storeId: 'store-1', comparisonPeriodEndLocalDate: '2026-08-19' }
    );
    expect(result.severity).toBe(DEFAULT_SEVERITY_BY_RULE_TYPE.margin_drop);
    expect(DEFAULT_MARGIN_DROP_THRESHOLD.minPercentagePointDrop).toBe(5);
  });
});

describe('evaluateUnmappedPosItems', () => {
  it('fires when at least one unmapped item exists for the store', () => {
    const result = evaluateUnmappedPosItems(3, { storeId: 'store-1' });
    expect(result.fires).toBe(true);
  });

  it('does not fire when the store has zero unmapped items', () => {
    const result = evaluateUnmappedPosItems(0, { storeId: 'store-1' });
    expect(result.fires).toBe(false);
  });

  it('the dedup key is per-store, stable regardless of the current unmapped count', () => {
    const three = evaluateUnmappedPosItems(3, { storeId: 'store-1' });
    const seven = evaluateUnmappedPosItems(7, { storeId: 'store-1' });
    expect(three.dedupKey).toBe(seven.dedupKey);
  });

  it('a different store produces a different dedup key', () => {
    const storeA = evaluateUnmappedPosItems(3, { storeId: 'store-1' });
    const storeB = evaluateUnmappedPosItems(3, { storeId: 'store-2' });
    expect(storeA.dedupKey).not.toBe(storeB.dedupKey);
  });

  it('falls back to the catalogue default severity when the caller supplies none', () => {
    const result = evaluateUnmappedPosItems(1, { storeId: 'store-1' });
    expect(result.severity).toBe(DEFAULT_SEVERITY_BY_RULE_TYPE.unmapped_pos_items);
  });
});

describe('evaluateDocumentReviewRequired', () => {
  it('fires when at least one document is stuck at REVIEW_REQUIRED for the store', () => {
    const result = evaluateDocumentReviewRequired(2, { storeId: 'store-1' });
    expect(result.fires).toBe(true);
  });

  it('does not fire when the store has zero review-required documents', () => {
    const result = evaluateDocumentReviewRequired(0, { storeId: 'store-1' });
    expect(result.fires).toBe(false);
  });

  it('the dedup key is per-store, stable regardless of the current review-required count', () => {
    const one = evaluateDocumentReviewRequired(1, { storeId: 'store-1' });
    const five = evaluateDocumentReviewRequired(5, { storeId: 'store-1' });
    expect(one.dedupKey).toBe(five.dedupKey);
  });

  it('a different store produces a different dedup key', () => {
    const storeA = evaluateDocumentReviewRequired(1, { storeId: 'store-1' });
    const storeB = evaluateDocumentReviewRequired(1, { storeId: 'store-2' });
    expect(storeA.dedupKey).not.toBe(storeB.dedupKey);
  });

  it('falls back to the catalogue default severity when the caller supplies none', () => {
    const result = evaluateDocumentReviewRequired(1, { storeId: 'store-1' });
    expect(result.severity).toBe(DEFAULT_SEVERITY_BY_RULE_TYPE.document_review_required);
  });
});

describe('evaluateStocktakeVariance', () => {
  it('fires when the largest magnitude meets the shared LARGE_VARIANCE_THRESHOLD (0.1)', () => {
    const result = evaluateStocktakeVariance({ maxVarianceMagnitude: '0.1', largestVarianceDollarValue: '-50.0000' }, { stockCountId: 'count-1' });
    expect(result.fires).toBe(true);
  });

  it('fires when the largest magnitude exceeds the threshold', () => {
    const result = evaluateStocktakeVariance({ maxVarianceMagnitude: '0.35', largestVarianceDollarValue: '-200.0000' }, { stockCountId: 'count-1' });
    expect(result.fires).toBe(true);
  });

  it('does not fire when the largest magnitude is below the threshold', () => {
    const result = evaluateStocktakeVariance({ maxVarianceMagnitude: '0.05', largestVarianceDollarValue: '-10.0000' }, { stockCountId: 'count-1' });
    expect(result.fires).toBe(false);
  });

  it('does not fire when the magnitude is unknown — no line to compare against, never a fabricated zero (I7)', () => {
    const result = evaluateStocktakeVariance({ maxVarianceMagnitude: null, largestVarianceDollarValue: null }, { stockCountId: 'count-1' });
    expect(result.fires).toBe(false);
  });

  it('dollarImpact carries the real absolute variance value, never the signed one', () => {
    const result = evaluateStocktakeVariance({ maxVarianceMagnitude: '0.5', largestVarianceDollarValue: '-75.5000' }, { stockCountId: 'count-1' });
    expect(result.dollarImpact?.toFixed(4)).toBe('75.5000');
  });

  it('dollarImpact is null when the largest-magnitude line has no known dollar value', () => {
    const result = evaluateStocktakeVariance({ maxVarianceMagnitude: '0.5', largestVarianceDollarValue: null }, { stockCountId: 'count-1' });
    expect(result.dollarImpact).toBeNull();
  });

  it('falls back to the catalogue default severity when the caller supplies none', () => {
    const result = evaluateStocktakeVariance({ maxVarianceMagnitude: '0.5', largestVarianceDollarValue: '-75.5000' }, { stockCountId: 'count-1' });
    expect(result.severity).toBe(DEFAULT_SEVERITY_BY_RULE_TYPE.stocktake_variance);
  });

  it('the dedup key is per-count', () => {
    const countA = evaluateStocktakeVariance({ maxVarianceMagnitude: '0.5', largestVarianceDollarValue: '-75.0000' }, { stockCountId: 'count-1' });
    const countB = evaluateStocktakeVariance({ maxVarianceMagnitude: '0.5', largestVarianceDollarValue: '-75.0000' }, { stockCountId: 'count-2' });
    expect(countA.dedupKey).not.toBe(countB.dedupKey);
  });
});

describe('dedup key builders', () => {
  it('buildExpiryDedupKey matches the literal worked example', () => {
    expect(buildExpiryDedupKey('store-1', '2026-08-19')).toBe('expiry:store-1:2026-08-19');
  });

  it('buildPriceChangeDedupKey matches the literal worked example', () => {
    expect(buildPriceChangeDedupKey('supplier-1', 'product-1')).toBe('price_change:supplier-1:product-1');
  });

  it('buildStockBelowReorderDedupKey is unique per (store, product, variant)', () => {
    const a = buildStockBelowReorderDedupKey('store-1', 'product-1', 'variant-1');
    const b = buildStockBelowReorderDedupKey('store-1', 'product-1', 'variant-2');
    expect(a).not.toBe(b);
  });

  it('buildDailyBriefingDedupKey is unique per (store, local date), stable within the same day', () => {
    const today = buildDailyBriefingDedupKey('store-1', '2026-08-22');
    const sameDayRetry = buildDailyBriefingDedupKey('store-1', '2026-08-22');
    const tomorrow = buildDailyBriefingDedupKey('store-1', '2026-08-23');
    const otherStore = buildDailyBriefingDedupKey('store-2', '2026-08-22');
    expect(today).toBe(sameDayRetry);
    expect(today).not.toBe(tomorrow);
    expect(today).not.toBe(otherStore);
  });

  it('buildSalesAnomalyDedupKey matches the literal worked example', () => {
    expect(buildSalesAnomalyDedupKey('store-1', '2026-08-19')).toBe('sales_anomaly:store-1:2026-08-19');
  });

  it('buildUnmappedPosItemsDedupKey matches the literal worked example', () => {
    expect(buildUnmappedPosItemsDedupKey('store-1')).toBe('unmapped_pos_items:store-1');
  });

  it('buildDocumentReviewRequiredDedupKey matches the literal worked example', () => {
    expect(buildDocumentReviewRequiredDedupKey('store-1')).toBe('document_review_required:store-1');
  });

  it('buildStocktakeVarianceDedupKey matches the literal worked example', () => {
    expect(buildStocktakeVarianceDedupKey('count-1')).toBe('stocktake_variance:count-1');
  });
});

describe('resolveEffectiveSeverity', () => {
  it('returns the tenant-configured severity when one exists', () => {
    expect(resolveEffectiveSeverity('stock_below_reorder', 'CRITICAL')).toBe('CRITICAL');
  });

  it('falls back to the catalogue default when no tenant rule is configured', () => {
    expect(resolveEffectiveSeverity('document_review_required', null)).toBe('MEDIUM');
  });

  it('every rule type in the catalogue has a real default — never an accidental gap', () => {
    for (const ruleType of Object.keys(DEFAULT_SEVERITY_BY_RULE_TYPE) as Array<keyof typeof DEFAULT_SEVERITY_BY_RULE_TYPE>) {
      expect(resolveEffectiveSeverity(ruleType, null)).toBe(DEFAULT_SEVERITY_BY_RULE_TYPE[ruleType]);
    }
  });
});

describe('resolveApplicableRule', () => {
  const orgWide: CandidateRule = {
    id: 'rule-org',
    storeId: null,
    severity: 'MEDIUM',
    threshold: {},
    recipientRoles: ['MANAGER'],
    channels: ['EMAIL'],
  };
  const storeSpecific: CandidateRule = {
    id: 'rule-store',
    storeId: 'store-1',
    severity: 'CRITICAL',
    threshold: {},
    recipientRoles: ['MANAGER'],
    channels: ['EMAIL'],
  };

  it('a store-specific rule wins over an org-wide rule for that store', () => {
    const result = resolveApplicableRule([orgWide, storeSpecific], 'store-1');
    expect(result?.id).toBe('rule-store');
  });

  it('falls back to the org-wide rule when no store-specific rule exists for this store', () => {
    const result = resolveApplicableRule([orgWide], 'store-1');
    expect(result?.id).toBe('rule-org');
  });

  it('a store-specific rule for a DIFFERENT store does not apply — falls back to org-wide', () => {
    const otherStoreRule: CandidateRule = { ...storeSpecific, id: 'rule-store-2', storeId: 'store-2' };
    const result = resolveApplicableRule([orgWide, otherStoreRule], 'store-1');
    expect(result?.id).toBe('rule-org');
  });

  it('returns null when the tenant has configured nothing at all — the caller falls back to catalogue defaults, never skips evaluation', () => {
    const result = resolveApplicableRule([], 'store-1');
    expect(result).toBeNull();
  });
});
