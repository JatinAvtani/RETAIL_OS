import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Decimal } from 'decimal.js';
import { buildReconciliationBatchReport, type ReconciledLine } from './reconciliation-batch';
import type { VarianceType } from './three-way-match';

const positiveCents = fc.integer({ min: 1, max: 1_000_000 }).map((c) => new Decimal(c).dividedBy(100));

const varianceTypeArb: fc.Arbitrary<VarianceType> = fc.constantFrom('CLEAN', 'PRICE_VARIANCE', 'QUANTITY_VARIANCE', 'UNORDERED_ITEM', 'INVOICED_NOT_RECEIVED');

/** A real line with real, resolvable inputs for whatever varianceType is generated — this arbitrary
 * never produces the "unparseable" null-input case, since that path is covered by dedicated example
 * tests above (property tests here are about the AGGREGATION invariants, not classification). */
const reconciledLineArb: fc.Arbitrary<ReconciledLine> = fc.record({
  lineId: fc.uuid(),
  invoiceMatchId: fc.uuid(),
  supplierName: fc.constant('Supplier'),
  productName: fc.constant('Product'),
  varianceType: varianceTypeArb,
  varianceSeverity: fc.constantFrom('NONE', 'LOW', 'MEDIUM', 'HIGH'),
  priceVariance: positiveCents,
  quantityVariance: positiveCents,
  invoiceQuantity: positiveCents,
  invoiceUnitPrice: positiveCents,
  explanation: fc.constant('generated'),
});

describe('buildReconciliationBatchReport — property tests', () => {
  it('matchRate is always between 0 and 1 inclusive, or null iff the batch is empty', () => {
    fc.assert(
      fc.property(fc.array(reconciledLineArb, { minLength: 0, maxLength: 80 }), (lines) => {
        const report = buildReconciliationBatchReport(lines);
        if (lines.length === 0) {
          expect(report.matchRate).toBeNull();
        } else {
          expect(report.matchRate).not.toBeNull();
          expect(report.matchRate!.greaterThanOrEqualTo(0)).toBe(true);
          expect(report.matchRate!.lessThanOrEqualTo(1)).toBe(true);
        }
      })
    );
  });

  it('cleanLines + exceptions.length always equals totalLines — every line is accounted for exactly once', () => {
    fc.assert(
      fc.property(fc.array(reconciledLineArb, { minLength: 0, maxLength: 80 }), (lines) => {
        const report = buildReconciliationBatchReport(lines);
        expect(report.cleanLines + report.exceptions.length).toBe(report.totalLines);
      })
    );
  });

  it('totalExceptionImpact always equals the sum of every exception line\'s own KNOWN dollarImpact — never drifts from a re-derivation', () => {
    fc.assert(
      fc.property(fc.array(reconciledLineArb, { minLength: 0, maxLength: 80 }), (lines) => {
        const report = buildReconciliationBatchReport(lines);
        const known = report.exceptions.map((e) => e.dollarImpact).filter((d): d is Decimal => d !== null);
        const expectedTotal = known.length === 0 ? (report.exceptions.length === 0 ? new Decimal(0) : null) : known.reduce((sum, d) => sum.plus(d), new Decimal(0));
        if (expectedTotal === null) {
          expect(report.totalExceptionImpact).toBeNull();
        } else {
          expect(report.totalExceptionImpact?.toString()).toBe(expectedTotal.toString());
        }
      })
    );
  });

  it('exceptions are always sorted by |dollarImpact| descending, with every null-impact line strictly after every known-impact line', () => {
    fc.assert(
      fc.property(fc.array(reconciledLineArb, { minLength: 0, maxLength: 80 }), (lines) => {
        const report = buildReconciliationBatchReport(lines);
        const knownIndices = report.exceptions.map((e, i) => (e.dollarImpact !== null ? i : -1)).filter((i) => i >= 0);
        const nullIndices = report.exceptions.map((e, i) => (e.dollarImpact === null ? i : -1)).filter((i) => i >= 0);
        if (knownIndices.length > 0 && nullIndices.length > 0) {
          expect(Math.max(...knownIndices)).toBeLessThan(Math.min(...nullIndices));
        }
        for (let i = 1; i < knownIndices.length; i++) {
          const prev = report.exceptions[knownIndices[i - 1]!]!.dollarImpact!;
          const curr = report.exceptions[knownIndices[i]!]!.dollarImpact!;
          expect(prev.abs().greaterThanOrEqualTo(curr.abs())).toBe(true);
        }
      })
    );
  });
});
