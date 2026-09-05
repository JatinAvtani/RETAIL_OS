import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { buildSupplierPriceVarianceFinding, type TrailingPricePoint } from './supplier-price-variance-finding';

const d = (v: string) => new Decimal(v);
const point = (overrides: Partial<TrailingPricePoint> = {}): TrailingPricePoint => ({
  unitPrice: d('10.00'),
  validFrom: new Date('2026-03-01'),
  currency: 'USD',
  sourceDocumentId: 'doc-latest',
  ...overrides,
});

describe('buildSupplierPriceVarianceFinding', () => {
  it('a real >2% price increase between the two most recent confirmed prices produces a finding, direction up', () => {
    const finding = buildSupplierPriceVarianceFinding({
      supplierName: 'Nova Foods',
      productName: 'Flour T55',
      history: [
        point({ unitPrice: d('11.20'), validFrom: new Date('2026-03-01'), sourceDocumentId: 'doc-latest' }),
        point({ unitPrice: d('10.00'), validFrom: new Date('2026-02-01'), sourceDocumentId: 'doc-previous' }),
      ],
    });

    expect(finding).not.toBeNull();
    expect(finding?.kind).toBe('SUPPLIER_PRICE_VARIANCE');
    expect(finding?.percentChange).toBe('12.0');
    expect(finding?.direction).toBe('up');
    expect(finding?.annualizedImpact).toBe('unknown'); // no trailing12moQuantity supplied
    expect(finding?.evidenceDocumentIds).toEqual(['doc-latest', 'doc-previous']);
  });

  it('a real price decrease produces direction down', () => {
    const finding = buildSupplierPriceVarianceFinding({
      supplierName: 'Nova Foods',
      productName: 'Flour T55',
      history: [point({ unitPrice: d('9.00') }), point({ unitPrice: d('10.00') })],
    });
    expect(finding?.direction).toBe('down');
  });

  it('a real trailing12moQuantity produces a real, priced annualizedImpact, never "unknown"', () => {
    const finding = buildSupplierPriceVarianceFinding({
      supplierName: 'Nova Foods',
      productName: 'Flour T55',
      history: [point({ unitPrice: d('11.00') }), point({ unitPrice: d('10.00') })],
      trailing12moQuantity: d('1000'),
    });
    // Δ1.00 * 1000 = 1000.00
    expect(finding?.annualizedImpact).toBe('1000.00');
  });

  it('fewer than 2 confirmed prices produces null — nothing to compare against yet (I7)', () => {
    expect(buildSupplierPriceVarianceFinding({ supplierName: 'X', productName: 'Y', history: [] })).toBeNull();
    expect(buildSupplierPriceVarianceFinding({ supplierName: 'X', productName: 'Y', history: [point()] })).toBeNull();
  });

  it('a change within the 2% default threshold produces no finding — not every fluctuation is worth surfacing', () => {
    const finding = buildSupplierPriceVarianceFinding({
      supplierName: 'X',
      productName: 'Y',
      history: [point({ unitPrice: d('10.10') }), point({ unitPrice: d('10.00') })],
    });
    expect(finding).toBeNull();
  });

  it('two prices in different currencies produce no finding — never converted or compared across currency (I6)', () => {
    const finding = buildSupplierPriceVarianceFinding({
      supplierName: 'X',
      productName: 'Y',
      history: [point({ unitPrice: d('11.00'), currency: 'EUR' }), point({ unitPrice: d('10.00'), currency: 'USD' })],
    });
    expect(finding).toBeNull();
  });

  it('an entry with no sourceDocumentId is excluded from evidenceDocumentIds, never a fabricated citation', () => {
    const finding = buildSupplierPriceVarianceFinding({
      supplierName: 'X',
      productName: 'Y',
      history: [
        point({ unitPrice: d('11.20'), sourceDocumentId: null }),
        point({ unitPrice: d('10.00'), sourceDocumentId: 'doc-previous' }),
      ],
    });
    expect(finding?.evidenceDocumentIds).toEqual(['doc-previous']);
  });

  it('a custom threshold is respected, not the hardcoded 2% default', () => {
    // A 5% change, under a custom 10% threshold — no finding.
    const finding = buildSupplierPriceVarianceFinding({
      supplierName: 'X',
      productName: 'Y',
      history: [point({ unitPrice: d('10.50') }), point({ unitPrice: d('10.00') })],
      thresholdPercent: d('0.10'),
    });
    expect(finding).toBeNull();
  });
});
