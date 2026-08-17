import { describe, expect, it } from 'vitest';
import { computeFactDailyConsumption, resolveTheoreticalCogsForDate } from './fact-daily-consumption.js';

describe('computeFactDailyConsumption', () => {
  it('groups real consumption movements by (productId, variantId), summing absolute quantity and cost', () => {
    const rows = computeFactDailyConsumption(
      '2026-06-15',
      [
        { productId: 'p1', variantId: 'v1', quantity: '-3.000000', unitCost: '2.0000' },
        { productId: 'p1', variantId: 'v1', quantity: '-2.000000', unitCost: '2.0000' },
      ],
      null
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actualQty).toBe('5.000000');
    // Hand-derived: 3*2.00 + 2*2.00 = 10.00
    expect(rows[0]!.actualCogs).toBe('10.0000');
  });

  it('a product/variant with even ONE unknown-cost movement gets actualCogs = null, never a partial sum (I7)', () => {
    const rows = computeFactDailyConsumption(
      '2026-06-15',
      [
        { productId: 'p1', variantId: 'v1', quantity: '-3.000000', unitCost: '2.0000' },
        { productId: 'p1', variantId: 'v1', quantity: '-2.000000', unitCost: null },
      ],
      null
    );
    expect(rows[0]!.actualQty).toBe('5.000000'); // quantity is still real and known
    expect(rows[0]!.actualCogs).toBeNull();
  });

  it('separate products/variants produce separate rows', () => {
    const rows = computeFactDailyConsumption(
      '2026-06-15',
      [
        { productId: 'p1', variantId: 'v1', quantity: '-1.000000', unitCost: '1.0000' },
        { productId: 'p2', variantId: 'v2', quantity: '-1.000000', unitCost: '1.0000' },
      ],
      null
    );
    expect(rows).toHaveLength(2);
  });

  it('a real theoreticalCogs value produces a separate sentinel row, not repeated on every product row', () => {
    const rows = computeFactDailyConsumption(
      '2026-06-15',
      [{ productId: 'p1', variantId: 'v1', quantity: '-1.000000', unitCost: '1.0000' }],
      '42.0000'
    );
    expect(rows).toHaveLength(2);
    const productRow = rows.find((r) => r.productId === 'p1')!;
    const sentinelRow = rows.find((r) => r.productId === null)!;
    expect(productRow.theoreticalCogs).toBeNull();
    expect(sentinelRow.theoreticalCogs).toBe('42.0000');
    expect(sentinelRow.variantId).toBeNull();
    expect(sentinelRow.actualQty).toBeNull();
    expect(sentinelRow.actualCogs).toBeNull();
  });

  it('a null theoreticalCogs produces NO sentinel row at all — not a sentinel carrying null', () => {
    const rows = computeFactDailyConsumption(
      '2026-06-15',
      [{ productId: 'p1', variantId: 'v1', quantity: '-1.000000', unitCost: '1.0000' }],
      null
    );
    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.productId !== null)).toBe(true);
  });

  it('an empty day with a real theoreticalCogs still produces just the one sentinel row', () => {
    const rows = computeFactDailyConsumption('2026-06-15', [], '10.0000');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.productId).toBeNull();
    expect(rows[0]!.theoreticalCogs).toBe('10.0000');
  });

  it('a genuinely empty day (no consumption, no theoretical figure) produces zero rows', () => {
    const rows = computeFactDailyConsumption('2026-06-15', [], null);
    expect(rows).toHaveLength(0);
  });
});

describe('resolveTheoreticalCogsForDate', () => {
  it('is null for an empty day — no sold items means no meaningful theoretical figure', async () => {
    const result = await resolveTheoreticalCogsForDate([], async () => 'unknown');
    expect(result).toBeNull();
  });

  it('sums quantitySold times resolved unit cost across distinct menu items', async () => {
    const resolver = async (menuItemId: string) => (menuItemId === 'menu-1' ? { amount: '2.0000' } : { amount: '3.0000' });
    const result = await resolveTheoreticalCogsForDate(
      [
        { menuItemId: 'menu-1', quantitySold: '5.000000' },
        { menuItemId: 'menu-2', quantitySold: '2.000000' },
      ],
      resolver
    );
    // Hand-derived: 5*2.00 + 2*3.00 = 10.00 + 6.00 = 16.00
    expect(result).toBe('16.0000');
  });

  it('resolves each DISTINCT menu item exactly once, even with multiple sold-item rows for the same item', async () => {
    let callCount = 0;
    const resolver = async () => {
      callCount++;
      return { amount: '1.0000' };
    };
    await resolveTheoreticalCogsForDate(
      [
        { menuItemId: 'menu-1', quantitySold: '1.000000' },
        { menuItemId: 'menu-1', quantitySold: '2.000000' },
      ],
      resolver
    );
    expect(callCount).toBe(1);
  });

  it('is null (I7) the moment ANY sold item has an unresolvable recipe cost, never a partial sum', async () => {
    const resolver = async (menuItemId: string) => (menuItemId === 'menu-1' ? { amount: '2.0000' } : ('unknown' as const));
    const result = await resolveTheoreticalCogsForDate(
      [
        { menuItemId: 'menu-1', quantitySold: '5.000000' },
        { menuItemId: 'menu-2', quantitySold: '1.000000' },
      ],
      resolver
    );
    expect(result).toBeNull();
  });
});
