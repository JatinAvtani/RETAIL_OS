import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Decimal } from 'decimal.js';
import { validateExtraction, type RawFields, type RawLine, type ValidationContext } from './validation';

/**
 * Property-based tests for the two arithmetic gates (LINE_ARITHMETIC, TOTAL_MISMATCH) — these are
 * exactly the calculations CLAUDE.md's testing discipline calls out: a subtle rounding/tolerance
 * bug here would silently wave through wrong invoice math for months.
 */

const field = (value: string | null) => ({ value });

const emptyFields = (): RawFields => ({
  supplier: field(null),
  documentNumber: field(null),
  documentDate: field(null),
  currency: field(null),
  subtotal: field(null),
  tax: field(null),
  discount: field(null),
  total: field(null),
});

const emptyLine = (): RawLine => ({
  sku: field(null),
  description: field(null),
  quantity: field(null),
  unit: field(null),
  unitPrice: field(null),
  lineTotal: field(null),
});

const context = (overrides: Partial<ValidationContext> = {}): ValidationContext => ({
  duplicateCandidates: [],
  trailingPricesByLineIndex: new Map(),
  today: new Date('2026-08-07T00:00:00Z'),
  ...overrides,
});

// Bounded to realistic invoice-line magnitudes, matching NUMERIC(19,4) precision — the same
// convention every other property test file in this project uses (see money.property.test.ts).
const positiveCents = fc.integer({ min: 1, max: 1_000_000 }).map((c) => c / 100);
const quantityValue = fc.integer({ min: 1, max: 10_000 }).map((q) => q / 100);

describe('validateExtraction — line arithmetic property', () => {
  it('never flags a line whose stated total is exactly quantity * unitPrice', () => {
    fc.assert(
      fc.property(quantityValue, positiveCents, (qty, unitPrice) => {
        const exactTotal = new Decimal(qty).times(unitPrice).toFixed(2);
        const line: RawLine = {
          ...emptyLine(),
          quantity: field(qty.toString()),
          unitPrice: field(unitPrice.toString()),
          lineTotal: field(exactTotal),
        };
        const result = validateExtraction(emptyFields(), [line], context());
        expect(result.issues.filter((i) => i.code === 'LINE_ARITHMETIC')).toHaveLength(0);
      })
    );
  });

  it('always flags a line whose stated total is off by more than the tolerance', () => {
    fc.assert(
      fc.property(
        quantityValue,
        positiveCents,
        fc.integer({ min: 2, max: 1000 }).map((c) => c / 100), // > 0.01 tolerance
        (qty, unitPrice, drift) => {
          const exact = new Decimal(qty).times(unitPrice);
          const wrongTotal = exact.plus(drift).toFixed(2);
          const line: RawLine = {
            ...emptyLine(),
            quantity: field(qty.toString()),
            unitPrice: field(unitPrice.toString()),
            lineTotal: field(wrongTotal),
          };
          const result = validateExtraction(emptyFields(), [line], context());
          expect(result.issues.some((i) => i.code === 'LINE_ARITHMETIC')).toBe(true);
        }
      )
    );
  });
});

describe('validateExtraction — document total property', () => {
  it('never flags a document whose total is exactly sum(lines) + tax - discount', () => {
    fc.assert(
      fc.property(
        fc.array(positiveCents, { minLength: 1, maxLength: 8 }),
        positiveCents,
        positiveCents,
        (lineTotals, tax, discount) => {
          const sum = lineTotals.reduce((acc, t) => acc.plus(t), new Decimal(0));
          const total = sum.plus(tax).minus(discount);
          // discount must not exceed sum+tax, or a negative total is a real anomaly the gate
          // would (correctly) still evaluate arithmetically — not what this property tests.
          fc.pre(total.greaterThanOrEqualTo(0));

          const lines: RawLine[] = lineTotals.map((t) => ({ ...emptyLine(), lineTotal: field(t.toFixed(2)) }));
          const fields: RawFields = { ...emptyFields(), tax: field(tax.toFixed(2)), discount: field(discount.toFixed(2)), total: field(total.toFixed(2)) };
          const result = validateExtraction(fields, lines, context());
          expect(result.issues.filter((i) => i.code === 'TOTAL_MISMATCH')).toHaveLength(0);
        }
      )
    );
  });
});
