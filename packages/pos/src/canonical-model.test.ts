import { describe, expect, it } from 'vitest';
import type { ExternalTransaction, ExternalCatalogItem } from './canonical-model';

/**
 * earlier work's actual validation exercise (the plan Phase 1: "validate the interface against Toast's
 * API shape before implementing Square, even though Toast ships in V2"). No real adapter exists
 * yet — these are hand-built fixtures shaped like each vendor's REAL documented API
 * response (Square's flat Order/LineItem, Toast's nested Order/Check/Selection with recursive
 * modifiers), proving `ExternalTransaction` can represent both without lossy flattening. This is
 * the test that would fail first if a future change accidentally narrowed the canonical model back
 * toward Square-only assumptions.
 */
describe('canonical model — validated against both vendors real shapes', () => {
  it('represents a Square order (flat line items, exactly one check, integer-cents money already normalized to a decimal string)', () => {
    // Square's real Order shape: flat line_items[], one payment surface (no check-splitting
    // concept at all). The adapter wraps this in a single-element `checks` array rather than the
    // canonical model special-casing "no checks" — every consumer handles exactly one shape.
    const squareOrder: ExternalTransaction = {
      externalId: 'sq-order-1',
      locationExternalId: 'sq-location-1',
      occurredAt: new Date('2026-01-05T12:00:00Z'),
      channel: 'POS',
      status: 'completed',
      checks: [
        {
          externalId: 'sq-order-1', // Square has no separate check id — the order IS the check
          lines: [
            {
              externalId: 'sq-line-1',
              posItemExternalId: 'sq-variation-cappuccino-medium',
              name: 'Cappuccino',
              quantity: '2',
              unitPrice: { amount: '4.50', currency: 'USD' },
              discount: { amount: '0.00', currency: 'USD' },
              lineTotal: { amount: '9.00', currency: 'USD' },
              modifiers: [], // Square's OrderLineItemModifier[] can be empty — the common case
              voided: false,
            },
          ],
          subtotal: { amount: '9.00', currency: 'USD' },
          discount: { amount: '0.00', currency: 'USD' },
          tax: { amount: '0.72', currency: 'USD' },
          total: { amount: '9.72', currency: 'USD' },
        },
      ],
    };

    expect(squareOrder.checks).toHaveLength(1);
    expect(squareOrder.checks[0]?.lines[0]?.modifiers).toEqual([]);
  });

  it('represents a Toast order (multiple independently-paid checks — a real table split — with recursively nested modifiers)', () => {
    // Toast's real Order shape: Order -> Check[] -> Selection[], and a Selection's modifiers are
    // themselves Selections, recursively. A single order legitimately settles as two separate
    // payments here (a genuine table split) — the exact shape a Square-only canonical model
    // cannot represent without either dropping a check or merging two payments into one.
    const toastOrder: ExternalTransaction = {
      externalId: 'toast-order-1',
      locationExternalId: 'toast-restaurant-1',
      occurredAt: new Date('2026-01-05T19:00:00Z'),
      channel: 'dine-in',
      status: 'completed',
      checks: [
        {
          externalId: 'toast-check-1',
          lines: [
            {
              externalId: 'toast-selection-1',
              posItemExternalId: 'toast-menuitem-burger',
              name: 'Cheeseburger',
              quantity: '1',
              unitPrice: { amount: '12.00', currency: 'USD' },
              discount: { amount: '0.00', currency: 'USD' },
              lineTotal: { amount: '12.00', currency: 'USD' },
              modifiers: [
                {
                  externalId: 'toast-modifier-no-pickles',
                  name: 'No Pickles',
                  modifiers: [
                    // a modifier-of-a-modifier — Toast's real, documented shape, not a hypothetical
                    {
                      externalId: 'toast-modifier-charge-as-extra',
                      name: 'Charge As Extra',
                      priceAdjustment: { amount: '0.50', currency: 'USD' },
                      modifiers: [],
                    },
                  ],
                },
              ],
              voided: false,
            },
          ],
          subtotal: { amount: '12.50', currency: 'USD' },
          discount: { amount: '0.00', currency: 'USD' },
          tax: { amount: '1.00', currency: 'USD' },
          total: { amount: '13.50', currency: 'USD' },
        },
        {
          // a second, independently-paid check on the SAME order — the exact table-split case
          externalId: 'toast-check-2',
          lines: [
            {
              externalId: 'toast-selection-2',
              posItemExternalId: 'toast-menuitem-salad',
              name: 'House Salad',
              quantity: '1',
              unitPrice: { amount: '9.00', currency: 'USD' },
              discount: { amount: '0.00', currency: 'USD' },
              lineTotal: { amount: '9.00', currency: 'USD' },
              modifiers: [],
              voided: false,
            },
          ],
          subtotal: { amount: '9.00', currency: 'USD' },
          discount: { amount: '0.00', currency: 'USD' },
          tax: { amount: '0.72', currency: 'USD' },
          total: { amount: '9.72', currency: 'USD' },
        },
      ],
    };

    expect(toastOrder.checks).toHaveLength(2);
    const nestedModifier = toastOrder.checks[0]?.lines[0]?.modifiers[0]?.modifiers[0];
    expect(nestedModifier?.name).toBe('Charge As Extra');
    expect(nestedModifier?.priceAdjustment?.amount).toBe('0.50');
  });

  it('represents both vendors catalog shape — a variation is always a separate priced entity, never the parent item itself', () => {
    // Square: CatalogObject(type=ITEM) has NO price; every priced thing is a nested
    // ITEM_VARIATION. Toast: MenuItem's optional `portions` play the same role, less universally.
    // A product with exactly one real SKU still gets exactly one variation row — never a
    // variation-less item — so pos_items always upserts the same shape either way.
    const singleSkuItem: ExternalCatalogItem = {
      externalId: 'sq-item-latte',
      name: 'Latte',
      category: 'Coffee',
      variations: [{ externalId: 'sq-variation-latte-regular', name: 'Regular', sku: 'LATTE-REG', price: { amount: '5.00', currency: 'USD' } }],
    };

    const multiVariationItem: ExternalCatalogItem = {
      externalId: 'sq-item-cappuccino',
      name: 'Cappuccino',
      category: 'Coffee',
      variations: [
        { externalId: 'sq-variation-cappuccino-small', name: 'Small', price: { amount: '4.00', currency: 'USD' } },
        { externalId: 'sq-variation-cappuccino-medium', name: 'Medium', price: { amount: '4.50', currency: 'USD' } },
      ],
    };

    expect(singleSkuItem.variations).toHaveLength(1);
    expect(multiVariationItem.variations).toHaveLength(2);
  });

  it('a refund transaction carries a back-reference to the original sale, never a synthetic standalone record', () => {
    const refund: ExternalTransaction = {
      externalId: 'sq-order-1-refund',
      locationExternalId: 'sq-location-1',
      occurredAt: new Date('2026-01-06T09:00:00Z'),
      status: 'refunded',
      refundOfExternalId: 'sq-order-1',
      checks: [
        {
          externalId: 'sq-order-1-refund',
          lines: [],
          subtotal: { amount: '-9.00', currency: 'USD' },
          discount: { amount: '0.00', currency: 'USD' },
          tax: { amount: '-0.72', currency: 'USD' },
          total: { amount: '-9.72', currency: 'USD' },
        },
      ],
    };

    expect(refund.refundOfExternalId).toBe('sq-order-1');
    expect(refund.status).toBe('refunded');
  });
});
