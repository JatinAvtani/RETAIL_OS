import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  aggregateNotificationContent,
  compareSeverity,
  formatLotExpiringBody,
  formatLotExpiringTitle,
  type AggregationItem,
} from './aggregation';

describe('aggregateNotificationContent', () => {
  it('throws on an empty item list — aggregation with nothing to aggregate is a caller bug', () => {
    expect(() => aggregateNotificationContent([], formatLotExpiringTitle, formatLotExpiringBody)).toThrow();
  });

  it('sums real dollarImpact across every priced item — the plan\'s "5 expiring lots -> 1 notification" example', () => {
    const items: AggregationItem[] = [
      { label: '12kg cream', dollarImpact: new Decimal('220.00'), severity: 'HIGH' },
      { label: '8kg berries', dollarImpact: new Decimal('120.00'), severity: 'HIGH' },
    ];
    const result = aggregateNotificationContent(items, formatLotExpiringTitle, formatLotExpiringBody);
    expect(result.totalDollarImpact?.toString()).toBe('340');
    expect(result.itemCount).toBe(2);
  });

  it('a mixed group (some items priced, some not) still sums the REAL priced ones — never drops to null for the whole group', () => {
    const items: AggregationItem[] = [
      { label: 'priced item', dollarImpact: new Decimal('220.00'), severity: 'HIGH' },
      { label: 'unpriced item', dollarImpact: null, severity: 'HIGH' },
    ];
    const result = aggregateNotificationContent(items, formatLotExpiringTitle, formatLotExpiringBody);
    expect(result.totalDollarImpact?.toString()).toBe('220');
  });

  it('a group with NO priced items at all has a null total — never a fabricated zero (I7)', () => {
    const items: AggregationItem[] = [
      { label: 'a', dollarImpact: null, severity: 'MEDIUM' },
      { label: 'b', dollarImpact: null, severity: 'MEDIUM' },
    ];
    const result = aggregateNotificationContent(items, formatLotExpiringTitle, formatLotExpiringBody);
    expect(result.totalDollarImpact).toBeNull();
  });

  it('the aggregate severity is the HIGHEST among the group\'s items, never quieter than its loudest constituent', () => {
    const items: AggregationItem[] = [
      { label: 'a', dollarImpact: new Decimal('10'), severity: 'MEDIUM' },
      { label: 'b', dollarImpact: new Decimal('900'), severity: 'CRITICAL' },
      { label: 'c', dollarImpact: new Decimal('5'), severity: 'HIGH' },
    ];
    const result = aggregateNotificationContent(items, formatLotExpiringTitle, formatLotExpiringBody);
    expect(result.severity).toBe('CRITICAL');
  });

  it('a single-item group still aggregates correctly (the degenerate case of "5 -> 1")', () => {
    const items: AggregationItem[] = [{ label: 'lone item', dollarImpact: new Decimal('50'), severity: 'HIGH' }];
    const result = aggregateNotificationContent(items, formatLotExpiringTitle, formatLotExpiringBody);
    expect(result.itemCount).toBe(1);
    expect(result.title).toBe('$50.00 at risk');
  });
});

describe('compareSeverity', () => {
  it('orders CRITICAL > HIGH > MEDIUM > INFO', () => {
    expect(compareSeverity('CRITICAL', 'HIGH')).toBeGreaterThan(0);
    expect(compareSeverity('HIGH', 'MEDIUM')).toBeGreaterThan(0);
    expect(compareSeverity('MEDIUM', 'INFO')).toBeGreaterThan(0);
    expect(compareSeverity('INFO', 'INFO')).toBe(0);
  });
});

describe('formatLotExpiringTitle / formatLotExpiringBody', () => {
  it('a single item reads as one alert, not "1 lots"', () => {
    expect(formatLotExpiringTitle(1, new Decimal('340'))).toBe('$340.00 at risk');
    expect(formatLotExpiringBody([{ label: '12kg cream', dollarImpact: new Decimal('340'), severity: 'HIGH' }])).toBe(
      '12kg cream is expiring soon.'
    );
  });

  it('multiple items name the count and join every label', () => {
    expect(formatLotExpiringTitle(2, new Decimal('340'))).toBe('$340.00 at risk — 2 lots expiring');
    const body = formatLotExpiringBody([
      { label: '12kg cream', dollarImpact: new Decimal('220'), severity: 'HIGH' },
      { label: '8kg berries', dollarImpact: new Decimal('120'), severity: 'HIGH' },
    ]);
    expect(body).toBe('12kg cream, 8kg berries are expiring soon.');
  });

  it('a null total (no priced items) still produces an honest title, never a fabricated dollar figure', () => {
    expect(formatLotExpiringTitle(3, null)).toBe('Stock at risk of expiring — 3 lots expiring');
  });
});
