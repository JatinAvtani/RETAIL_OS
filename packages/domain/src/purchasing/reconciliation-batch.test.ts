import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { buildReconciliationBatchReport, type ReconciledLine } from './reconciliation-batch';

const d = (v: string) => new Decimal(v);

const line = (overrides: Partial<ReconciledLine> = {}): ReconciledLine => ({
  lineId: 'line-1',
  invoiceMatchId: 'match-1',
  supplierName: 'Test Supplier',
  productName: 'Test Product',
  varianceType: 'CLEAN',
  varianceSeverity: 'NONE',
  priceVariance: null,
  quantityVariance: null,
  invoiceQuantity: d('10'),
  invoiceUnitPrice: d('5'),
  explanation: 'ok',
  ...overrides,
});

describe('buildReconciliationBatchReport', () => {
  it('an all-CLEAN batch has matchRate 1 and zero exceptions', () => {
    const lines = Array.from({ length: 55 }, (_, i) => line({ lineId: `line-${i}` }));
    const report = buildReconciliationBatchReport(lines);

    expect(report.totalLines).toBe(55);
    expect(report.cleanLines).toBe(55);
    expect(report.matchRate?.toString()).toBe('1');
    expect(report.exceptions).toHaveLength(0);
    expect(report.totalExceptionImpact?.toString()).toBe('0');
    expect(report.unresolvableCount).toBe(0);
  });

  it('an empty batch reports matchRate null (I7), never a fabricated 100% or 0%', () => {
    const report = buildReconciliationBatchReport([]);
    expect(report.totalLines).toBe(0);
    expect(report.matchRate).toBeNull();
    expect(report.totalExceptionImpact?.toString()).toBe('0');
  });

  it('a real mixed batch computes an honest matchRate and ranks exceptions by |dollarImpact| descending', () => {
    const lines: ReconciledLine[] = [
      line({ lineId: 'clean-1' }),
      line({ lineId: 'clean-2' }),
      line({
        lineId: 'small-price-variance',
        varianceType: 'PRICE_VARIANCE',
        varianceSeverity: 'MEDIUM',
        priceVariance: d('0.50'),
        invoiceQuantity: d('10'),
        invoiceUnitPrice: d('5.50'),
        explanation: 'small variance',
      }),
      line({
        lineId: 'big-invoiced-not-received',
        varianceType: 'INVOICED_NOT_RECEIVED',
        varianceSeverity: 'HIGH',
        invoiceQuantity: d('100'),
        invoiceUnitPrice: d('20'),
        explanation: 'never arrived',
      }),
    ];

    const report = buildReconciliationBatchReport(lines);

    expect(report.totalLines).toBe(4);
    expect(report.cleanLines).toBe(2);
    expect(report.matchRate?.toString()).toBe('0.5');
    expect(report.exceptions).toHaveLength(2);
    // 100 * 20 = 2000 (big), 0.5 * 10 = 5 (small) — big must rank first.
    expect(report.exceptions[0]?.lineId).toBe('big-invoiced-not-received');
    expect(report.exceptions[0]?.dollarImpact?.toString()).toBe('2000');
    expect(report.exceptions[1]?.lineId).toBe('small-price-variance');
    expect(report.exceptions[1]?.dollarImpact?.toString()).toBe('5');
    expect(report.totalExceptionImpact?.toString()).toBe('2005');
    expect(report.unresolvableCount).toBe(0);
  });

  it('a line whose dollar impact cannot be computed sorts LAST, never dropped, never treated as zero', () => {
    const lines: ReconciledLine[] = [
      line({
        lineId: 'small-known',
        varianceType: 'PRICE_VARIANCE',
        priceVariance: d('1'),
        invoiceQuantity: d('1'),
        invoiceUnitPrice: d('1'),
      }),
      line({
        lineId: 'unresolvable',
        varianceType: 'PRICE_VARIANCE',
        priceVariance: d('999'),
        invoiceQuantity: null, // makes computeLineDollarImpact return null for this line
        invoiceUnitPrice: null,
      }),
    ];

    const report = buildReconciliationBatchReport(lines);

    expect(report.exceptions).toHaveLength(2);
    expect(report.exceptions.map((e) => e.lineId)).toEqual(['small-known', 'unresolvable']);
    expect(report.exceptions[1]?.dollarImpact).toBeNull();
    expect(report.unresolvableCount).toBe(1);
    // Total must reflect ONLY the known $1 impact, never treating the unresolvable line as $0.
    expect(report.totalExceptionImpact?.toString()).toBe('1');
  });

  it('when EVERY exception is unresolvable, totalExceptionImpact is null, never a fabricated 0', () => {
    const lines: ReconciledLine[] = [
      line({ lineId: 'unresolvable-1', varianceType: 'PRICE_VARIANCE', priceVariance: d('5'), invoiceQuantity: null, invoiceUnitPrice: null }),
      line({ lineId: 'unresolvable-2', varianceType: 'QUANTITY_VARIANCE', quantityVariance: d('3'), invoiceQuantity: null, invoiceUnitPrice: null }),
    ];

    const report = buildReconciliationBatchReport(lines);

    expect(report.exceptions).toHaveLength(2);
    expect(report.unresolvableCount).toBe(2);
    expect(report.totalExceptionImpact).toBeNull();
  });

  it('a signed negative dollarImpact (a credit owed back) is preserved, never collapsed to absolute value', () => {
    const lines: ReconciledLine[] = [
      line({
        lineId: 'undercharge',
        varianceType: 'PRICE_VARIANCE',
        priceVariance: d('-2'), // invoiced LESS than the PO price
        invoiceQuantity: d('10'),
        invoiceUnitPrice: d('8'),
      }),
    ];

    const report = buildReconciliationBatchReport(lines);
    expect(report.exceptions[0]?.dollarImpact?.toString()).toBe('-20');
    expect(report.totalExceptionImpact?.toString()).toBe('-20');
  });
});
