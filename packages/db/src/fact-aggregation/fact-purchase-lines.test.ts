import { describe, expect, it } from 'vitest';
import { computeFactPurchaseLines } from './fact-purchase-lines.js';

describe('computeFactPurchaseLines', () => {
  it('maps each real PO line to its own fact row, 1:1, no merging', () => {
    const rows = computeFactPurchaseLines('2026-06-15', [
      { supplierId: 's1', poId: 'po1', productId: 'p1', qty: '10.000000', unitPrice: '2.0000', lineTotal: '20.0000' },
      { supplierId: 's1', poId: 'po2', productId: 'p1', qty: '5.000000', unitPrice: '2.0000', lineTotal: '10.0000' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.poId).toBe('po1');
    expect(rows[1]!.poId).toBe('po2');
  });

  it('carries the real total through unchanged, never recomputed from qty*unitPrice', () => {
    // A real line's lineTotal might legitimately differ from qty*unitPrice due to rounding — the
    // source of truth is the real stored total, never re-derived here.
    const rows = computeFactPurchaseLines('2026-06-15', [
      { supplierId: 's1', poId: 'po1', productId: 'p1', qty: '3.000000', unitPrice: '3.3333', lineTotal: '10.0000' },
    ]);
    expect(rows[0]!.total).toBe('10.0000');
  });
});
