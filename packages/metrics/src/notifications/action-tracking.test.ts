import { describe, expect, it } from 'vitest';
import {
  computeActionRatesByRuleType,
  findRuleTypesNeedingTuning,
  type ActionTrackingRow,
} from './action-tracking';

const row = (overrides: Partial<ActionTrackingRow>): ActionTrackingRow => ({
  notificationId: 'n1',
  ruleType: 'stock_below_reorder',
  actedAt: null,
  deliveryId: null,
  deliveredAt: null,
  openedAt: null,
  ...overrides,
});

describe('computeActionRatesByRuleType', () => {
  it('returns an empty array for no rows', () => {
    expect(computeActionRatesByRuleType([])).toEqual([]);
  });

  it('counts a single acted notification with no deliveries', () => {
    const result = computeActionRatesByRuleType([row({ actedAt: new Date() })]);
    expect(result).toEqual([
      {
        ruleType: 'stock_below_reorder',
        notificationCount: 1,
        actedCount: 1,
        deliveryCount: 0,
        deliveredCount: 0,
        openedCount: 0,
        actionRate: 1,
        openRate: null,
      },
    ]);
  });

  it('action rate is per-NOTIFICATION, not per-delivery — one acted notification fanned out to two recipients is still 1/1, never 2/2 double-counted or diluted', () => {
    const result = computeActionRatesByRuleType([
      row({ notificationId: 'n1', actedAt: new Date(), deliveryId: 'd1', deliveredAt: new Date() }),
      row({ notificationId: 'n1', actedAt: new Date(), deliveryId: 'd2', deliveredAt: new Date() }),
    ]);
    expect(result[0]?.notificationCount).toBe(1);
    expect(result[0]?.actedCount).toBe(1);
    expect(result[0]?.actionRate).toBe(1);
    expect(result[0]?.deliveryCount).toBe(2);
  });

  it('computes the real mixed fraction across several notifications of the same rule type', () => {
    const result = computeActionRatesByRuleType([
      row({ notificationId: 'n1', actedAt: new Date() }),
      row({ notificationId: 'n2', actedAt: null }),
      row({ notificationId: 'n3', actedAt: null }),
      row({ notificationId: 'n4', actedAt: null }),
    ]);
    expect(result[0]?.notificationCount).toBe(4);
    expect(result[0]?.actedCount).toBe(1);
    expect(result[0]?.actionRate).toBe(0.25);
  });

  it('open rate is null when no delivery has ever happened for a rule type — a genuine unknown, never a fabricated 0% (I7)', () => {
    const result = computeActionRatesByRuleType([row({ deliveryId: null })]);
    expect(result[0]?.openRate).toBeNull();
  });

  it('open rate is a real fraction of delivered deliveries that were opened, distinct from the delivered rate', () => {
    const result = computeActionRatesByRuleType([
      row({ notificationId: 'n1', deliveryId: 'd1', deliveredAt: new Date(), openedAt: new Date() }),
      row({ notificationId: 'n1', deliveryId: 'd2', deliveredAt: new Date(), openedAt: null }),
    ]);
    expect(result[0]?.deliveryCount).toBe(2);
    expect(result[0]?.deliveredCount).toBe(2);
    expect(result[0]?.openedCount).toBe(1);
    expect(result[0]?.openRate).toBe(0.5);
  });

  it('separates distinct rule types into separate results', () => {
    const result = computeActionRatesByRuleType([
      row({ ruleType: 'stock_below_reorder', notificationId: 'n1', actedAt: new Date() }),
      row({ ruleType: 'lot_expiring', notificationId: 'n2', actedAt: null }),
    ]);
    const ruleTypes = result.map((r) => r.ruleType).sort();
    expect(ruleTypes).toEqual(['lot_expiring', 'stock_below_reorder']);
  });

  it('sorts ascending by action rate — the lowest-performing (most tuning-worthy) rule type first', () => {
    const result = computeActionRatesByRuleType([
      row({ ruleType: 'high_action', notificationId: 'n1', actedAt: new Date() }),
      row({ ruleType: 'low_action', notificationId: 'n2', actedAt: null }),
    ]);
    expect(result.map((r) => r.ruleType)).toEqual(['low_action', 'high_action']);
  });

  it('a duplicated delivery row (the same deliveryId appearing twice, e.g. from a join fan-out) is still counted once, not twice', () => {
    const result = computeActionRatesByRuleType([
      row({ notificationId: 'n1', deliveryId: 'd1', deliveredAt: new Date() }),
      row({ notificationId: 'n1', deliveryId: 'd1', deliveredAt: new Date() }),
    ]);
    expect(result[0]?.deliveryCount).toBe(1);
    expect(result[0]?.deliveredCount).toBe(1);
  });
});

describe('findRuleTypesNeedingTuning', () => {
  it('excludes a rule type below the minimum sample size even at a 0% action rate — one data point proves nothing', () => {
    const rates = computeActionRatesByRuleType([
      row({ ruleType: 'rare_alert', notificationId: 'n1', actedAt: null }),
    ]);
    expect(findRuleTypesNeedingTuning(rates)).toEqual([]);
  });

  it('flags a rule type at or above the sample size with a genuinely low action rate', () => {
    const rows: ActionTrackingRow[] = Array.from({ length: 5 }, (_, i) =>
      row({ ruleType: 'ignored_alert', notificationId: `n${i}`, actedAt: null })
    );
    const rates = computeActionRatesByRuleType(rows);
    const flagged = findRuleTypesNeedingTuning(rates);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.ruleType).toBe('ignored_alert');
  });

  it('does not flag a rule type with an adequate sample and a healthy action rate', () => {
    const rows: ActionTrackingRow[] = Array.from({ length: 5 }, (_, i) =>
      row({ ruleType: 'healthy_alert', notificationId: `n${i}`, actedAt: new Date() })
    );
    const rates = computeActionRatesByRuleType(rows);
    expect(findRuleTypesNeedingTuning(rates)).toEqual([]);
  });

  it('the exact boundary: a rate exactly at the threshold is NOT flagged (strictly less-than)', () => {
    const rows: ActionTrackingRow[] = [
      ...Array.from({ length: 4 }, (_, i) => row({ ruleType: 'boundary_alert', notificationId: `n${i}`, actedAt: null })),
      row({ ruleType: 'boundary_alert', notificationId: 'n4', actedAt: new Date() }),
    ];
    const rates = computeActionRatesByRuleType(rows);
    expect(rates[0]?.actionRate).toBe(0.2);
    expect(findRuleTypesNeedingTuning(rates)).toEqual([]);
  });
});
