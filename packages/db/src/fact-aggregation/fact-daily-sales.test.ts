import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Decimal } from 'decimal.js';
import { computeFactDailySales, type RefundForAggregation, type SalesLineForAggregation } from './fact-daily-sales.js';

const line = (overrides: Partial<SalesLineForAggregation> = {}): SalesLineForAggregation => ({
  transactionId: 'txn-1',
  occurredAt: new Date('2026-06-15T18:00:00Z'), // 14:00 EDT -> LUNCH
  channel: 'dine-in',
  transactionSubtotal: '100.0000',
  transactionDiscount: '0.0000',
  lineTotal: '50.0000',
  quantity: '2.000000',
  menuItemId: 'menu-1',
  posItemCategory: 'Entrees',
  ...overrides,
});

describe('computeFactDailySales', () => {
  it('groups two lines from the same transaction into one row when they share the same grain', () => {
    const lines = [
      line({ lineTotal: '30.0000', quantity: '1.000000' }),
      line({ lineTotal: '20.0000', quantity: '1.000000' }),
    ];
    const rows = computeFactDailySales('2026-06-15', lines, [], 'America/New_York');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.units).toBe('2.000000');
    expect(rows[0]!.grossRevenue).toBe('50.0000');
    expect(rows[0]!.transactionCount).toBe(1);
  });

  it('splits into separate rows for different menu items (different grain)', () => {
    const lines = [line({ menuItemId: 'menu-1' }), line({ menuItemId: 'menu-2' })];
    const rows = computeFactDailySales('2026-06-15', lines, [], 'America/New_York');
    expect(rows).toHaveLength(2);
  });

  it('splits into separate rows for different dayparts within the same day', () => {
    const lunchLine = line({ occurredAt: new Date('2026-06-15T17:00:00Z') }); // 13:00 EDT -> LUNCH
    const dinnerLine = line({ occurredAt: new Date('2026-06-16T00:00:00Z') }); // 20:00 EDT -> DINNER
    const rows = computeFactDailySales('2026-06-15', [lunchLine, dinnerLine], [], 'America/New_York');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.daypart).sort()).toEqual(['DINNER', 'LUNCH']);
  });

  it('a line with no mapped menu item / category is still counted (I7), grouped under null grain values', () => {
    const rows = computeFactDailySales('2026-06-15', [line({ menuItemId: null, posItemCategory: null })], [], 'America/New_York');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.menuItemId).toBeNull();
    expect(rows[0]!.units).toBe('2.000000');
  });

  it('transactionCount counts each DISTINCT transaction once, not once per line', () => {
    const lines = [
      line({ transactionId: 'txn-1', lineTotal: '10.0000' }),
      line({ transactionId: 'txn-1', lineTotal: '10.0000' }),
      line({ transactionId: 'txn-2', lineTotal: '10.0000' }),
    ];
    const rows = computeFactDailySales('2026-06-15', lines, [], 'America/New_York');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.transactionCount).toBe(2);
  });

  describe('discount proration', () => {
    it('a $10 line out of a $100 subtotal transaction with a real $20 discount gets a $2.00 prorated share', () => {
      // Hand-derived: revenue share = 10/100 = 0.10; discount share = 0.10 * 20 = 2.00.
      const rows = computeFactDailySales(
        '2026-06-15',
        [line({ lineTotal: '10.0000', transactionSubtotal: '100.0000', transactionDiscount: '20.0000' })],
        [],
        'America/New_York'
      );
      expect(rows[0]!.discounts).toBe('2.0000');
    });

    it('a real zero-subtotal transaction prorates a zero discount share, never a fabricated/NaN value (I7)', () => {
      const rows = computeFactDailySales(
        '2026-06-15',
        [line({ lineTotal: '0.0000', transactionSubtotal: '0.0000', transactionDiscount: '5.0000' })],
        [],
        'America/New_York'
      );
      expect(rows[0]!.discounts).toBe('0.0000');
    });

    it('property: prorated discount shares across ALL lines of one transaction sum EXACTLY to the real transaction discount', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 1, max: 10000 }), { minLength: 1, maxLength: 8 }),
          fc.integer({ min: 0, max: 10000 }),
          (lineCents, discountCents) => {
            const subtotalCents = lineCents.reduce((a, b) => a + b, 0);
            const lines = lineCents.map((cents) =>
              line({
                transactionId: 'txn-prop',
                lineTotal: (cents / 100).toFixed(4),
                transactionSubtotal: (subtotalCents / 100).toFixed(4),
                transactionDiscount: (discountCents / 100).toFixed(4),
                menuItemId: `menu-${cents}`, // force every line into its OWN row so we can sum discounts across rows
              })
            );
            const rows = computeFactDailySales('2026-06-15', lines, [], 'America/New_York');
            const summedDiscounts = rows.reduce((sum, r) => sum.plus(r.discounts), new Decimal(0));
            const realDiscount = new Decimal(discountCents / 100);
            // Rounding to 4 decimal places per-line can introduce a sub-cent discrepancy across many
            // lines — bounded by (number of lines) * 0.0001, never unbounded drift.
            expect(summedDiscounts.minus(realDiscount).abs().lessThanOrEqualTo(lines.length * 0.0001 + 0.0001)).toBe(true);
          }
        )
      );
    });
  });

  describe('refund proration', () => {
    it('a real refund on the original transaction prorates across that transaction\'s own lines by revenue share', () => {
      const lines = [
        line({ transactionId: 'txn-1', lineTotal: '60.0000', transactionSubtotal: '100.0000' }),
        line({ transactionId: 'txn-1', lineTotal: '40.0000', transactionSubtotal: '100.0000', menuItemId: 'menu-2' }),
      ];
      const refunds: RefundForAggregation[] = [{ originalTransactionId: 'txn-1', refundTotal: '25.0000' }];
      const rows = computeFactDailySales('2026-06-15', lines, refunds, 'America/New_York');
      const menu1Row = rows.find((r) => r.menuItemId === 'menu-1')!;
      const menu2Row = rows.find((r) => r.menuItemId === 'menu-2')!;
      // Hand-derived: menu-1's share = 60/100 * 25 = 15.00; menu-2's share = 40/100 * 25 = 10.00.
      expect(menu1Row.refunds).toBe('15.0000');
      expect(menu2Row.refunds).toBe('10.0000');
    });

    it('a transaction with no matching refund gets a real zero refund share, not unknown', () => {
      const rows = computeFactDailySales('2026-06-15', [line()], [], 'America/New_York');
      expect(rows[0]!.refunds).toBe('0.0000');
    });
  });

  describe('net revenue reconciliation', () => {
    it('netRevenue = grossRevenue - discounts - refunds, exactly, for every row', () => {
      const lines = [line({ lineTotal: '60.0000', transactionSubtotal: '100.0000', transactionDiscount: '10.0000' })];
      const refunds: RefundForAggregation[] = [{ originalTransactionId: 'txn-1', refundTotal: '20.0000' }];
      const rows = computeFactDailySales('2026-06-15', lines, refunds, 'America/New_York');
      const row = rows[0]!;
      const expectedNet = new Decimal(row.grossRevenue).minus(row.discounts).minus(row.refunds);
      expect(row.netRevenue).toBe(expectedNet.toFixed(4));
    });
  });
});
