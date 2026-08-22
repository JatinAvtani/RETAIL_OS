import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  buildDailyBriefingDedupKey,
  buildExpiryDedupKey,
  buildPriceChangeDedupKey,
  buildStockBelowReorderDedupKey,
  DEFAULT_LOT_EXPIRING_THRESHOLD,
  DEFAULT_SEVERITY_BY_RULE_TYPE,
  evaluateLotExpiring,
  evaluateStockBelowReorder,
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
