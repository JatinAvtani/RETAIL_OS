import { describe, expect, it } from 'vitest';
import { computeFactWaste } from './fact-waste.js';

describe('computeFactWaste', () => {
  it('groups by (productId, reasonCode), summing quantity and value', () => {
    const rows = computeFactWaste('2026-06-15', [
      { productId: 'p1', reasonCode: 'SPILLAGE', quantity: '-3.000000', unitCost: '2.0000' },
      { productId: 'p1', reasonCode: 'SPILLAGE', quantity: '-1.000000', unitCost: '2.0000' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qty).toBe('4.000000');
    expect(rows[0]!.value).toBe('8.0000'); // 4 * 2.00
  });

  it('separates rows by reasonCode even for the same product', () => {
    const rows = computeFactWaste('2026-06-15', [
      { productId: 'p1', reasonCode: 'SPILLAGE', quantity: '-1.000000', unitCost: '1.0000' },
      { productId: 'p1', reasonCode: 'EXPIRED', quantity: '-1.000000', unitCost: '1.0000' },
    ]);
    expect(rows).toHaveLength(2);
  });

  it('value is null (I7) when even one contributing movement has an unknown unit cost', () => {
    const rows = computeFactWaste('2026-06-15', [
      { productId: 'p1', reasonCode: 'SPILLAGE', quantity: '-1.000000', unitCost: '1.0000' },
      { productId: 'p1', reasonCode: 'SPILLAGE', quantity: '-1.000000', unitCost: null },
    ]);
    expect(rows[0]!.qty).toBe('2.000000'); // quantity still real and known
    expect(rows[0]!.value).toBeNull();
  });

  it('a row with a null reasonCode (should be unreachable per the real DB constraint) is skipped, never fabricating a reason', () => {
    const rows = computeFactWaste('2026-06-15', [{ productId: 'p1', reasonCode: null, quantity: '-1.000000', unitCost: '1.0000' }]);
    expect(rows).toHaveLength(0);
  });
});
