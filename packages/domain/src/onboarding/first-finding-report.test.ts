import { describe, expect, it } from 'vitest';
import {
  buildCrossSupplierPriceFindings,
  buildDuplicateInvoiceFindings,
  buildPriceChangeFinding,
  rankFindings,
  type Finding,
  type PriceChangeFinding,
} from './first-finding-report';

describe('buildPriceChangeFinding', () => {
  it('re-derives a real percent change from the persisted event values and reports direction up', () => {
    const finding = buildPriceChangeFinding({
      supplierName: 'Nova Foods',
      productName: 'Flour T55',
      expectedValue: '10.00',
      actualValue: '11.20',
      variance: '1430.00',
      occurredAt: new Date('2026-03-01'),
      evidenceDocumentIds: ['doc-a', 'doc-b', 'doc-c'],
    });
    expect(finding?.percentChange).toBe('12.0');
    expect(finding?.direction).toBe('up');
    expect(finding?.annualizedImpact).toBe('1430.00');
  });

  it('reports direction down for a real price decrease', () => {
    const finding = buildPriceChangeFinding({
      supplierName: 'Nova Foods',
      productName: 'Flour T55',
      expectedValue: '10.00',
      actualValue: '9.00',
      variance: '-500.00',
      occurredAt: new Date('2026-03-01'),
      evidenceDocumentIds: ['doc-a'],
    });
    expect(finding?.direction).toBe('down');
  });

  it('reports a null annualizedImpact honestly when no trailing history exists, never a fabricated figure', () => {
    const finding = buildPriceChangeFinding({
      supplierName: 'Nova Foods',
      productName: 'Flour T55',
      expectedValue: '10.00',
      actualValue: '11.20',
      variance: null,
      occurredAt: new Date('2026-03-01'),
      evidenceDocumentIds: ['doc-a'],
    });
    expect(finding?.annualizedImpact).toBeNull();
    expect(finding?.percentChange).toBe('12.0');
  });

  it('returns null (no finding) when the old price was zero — an undefined percent change, never a guess', () => {
    const finding = buildPriceChangeFinding({
      supplierName: 'Nova Foods',
      productName: 'Flour T55',
      expectedValue: '0',
      actualValue: '5.00',
      variance: null,
      occurredAt: new Date('2026-03-01'),
      evidenceDocumentIds: ['doc-a'],
    });
    expect(finding).toBeNull();
  });
});

describe('buildDuplicateInvoiceFindings', () => {
  it('finds a real duplicate pair sharing the same content hash', () => {
    const findings = buildDuplicateInvoiceFindings([
      { id: 'doc-8891-a', contentHash: 'hash-x', supplierName: 'Nova Foods', documentNumber: '8891', total: '340.00' },
      { id: 'doc-8891-b', contentHash: 'hash-x', supplierName: 'Nova Foods', documentNumber: '8891', total: '340.00' },
      { id: 'doc-other', contentHash: 'hash-y', supplierName: 'Aurora Dairy', documentNumber: '100', total: '50.00' },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.total).toBe('340.00');
    expect(findings[0]!.evidenceDocumentIds.sort()).toEqual(['doc-8891-a', 'doc-8891-b']);
  });

  it('does NOT report a single, non-duplicated document', () => {
    const findings = buildDuplicateInvoiceFindings([
      { id: 'doc-a', contentHash: 'hash-x', supplierName: 'Nova Foods', documentNumber: '1', total: '10.00' },
    ]);
    expect(findings).toEqual([]);
  });

  it('skips a duplicate group with no real supplier/total to cite, never fabricates one', () => {
    const findings = buildDuplicateInvoiceFindings([
      { id: 'doc-a', contentHash: 'hash-x', supplierName: null, documentNumber: null, total: null },
      { id: 'doc-b', contentHash: 'hash-x', supplierName: null, documentNumber: null, total: null },
    ]);
    expect(findings).toEqual([]);
  });
});

describe('buildCrossSupplierPriceFindings', () => {
  it('finds a real cross-supplier price gap for the SAME real pack size', () => {
    const findings = buildCrossSupplierPriceFindings({
      productName: 'Butter Unsalted',
      quotes: [
        { supplierName: 'Nova', unitPrice: '5.00', packSize: '1', packUnitCode: 'kg', evidenceDocumentId: 'doc-nova' },
        { supplierName: 'Aurora', unitPrice: '5.90', packSize: '1', packUnitCode: 'kg', evidenceDocumentId: 'doc-aurora' },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.cheaperSupplierName).toBe('Nova');
    expect(findings[0]!.pricierSupplierName).toBe('Aurora');
    expect(findings[0]!.percentDifference).toBe('18.0');
  });

  it('does NOT compare quotes with different real pack sizes — no converted guess (I6)', () => {
    const findings = buildCrossSupplierPriceFindings({
      productName: 'Butter Unsalted',
      quotes: [
        { supplierName: 'Nova', unitPrice: '5.00', packSize: '1', packUnitCode: 'kg', evidenceDocumentId: 'doc-nova' },
        { supplierName: 'Aurora', unitPrice: '2.50', packSize: '500', packUnitCode: 'g', evidenceDocumentId: 'doc-aurora' },
      ],
    });
    expect(findings).toEqual([]);
  });

  it('skips a quote with no real pack size, never guesses one', () => {
    const findings = buildCrossSupplierPriceFindings({
      productName: 'Butter Unsalted',
      quotes: [
        { supplierName: 'Nova', unitPrice: '5.00', packSize: null, packUnitCode: null, evidenceDocumentId: 'doc-nova' },
        { supplierName: 'Aurora', unitPrice: '5.90', packSize: '1', packUnitCode: 'kg', evidenceDocumentId: 'doc-aurora' },
      ],
    });
    expect(findings).toEqual([]);
  });

  it('reports no finding when only one real supplier quote exists for a pack size', () => {
    const findings = buildCrossSupplierPriceFindings({
      productName: 'Butter Unsalted',
      quotes: [{ supplierName: 'Nova', unitPrice: '5.00', packSize: '1', packUnitCode: 'kg', evidenceDocumentId: 'doc-nova' }],
    });
    expect(findings).toEqual([]);
  });

  it('reports no finding when both suppliers charge the exact same real price', () => {
    const findings = buildCrossSupplierPriceFindings({
      productName: 'Butter Unsalted',
      quotes: [
        { supplierName: 'Nova', unitPrice: '5.00', packSize: '1', packUnitCode: 'kg', evidenceDocumentId: 'doc-nova' },
        { supplierName: 'Aurora', unitPrice: '5.00', packSize: '1', packUnitCode: 'kg', evidenceDocumentId: 'doc-aurora' },
      ],
    });
    expect(findings).toEqual([]);
  });
});

describe('rankFindings', () => {
  const priceChange = (impact: string, docs: string[]): PriceChangeFinding => ({
    kind: 'PRICE_CHANGE',
    supplierName: 'Nova',
    productName: 'Flour',
    percentChange: '12.0',
    direction: 'up',
    annualizedImpact: impact,
    occurredAt: new Date(),
    evidenceDocumentIds: docs,
  });
  const duplicate = (total: string, docs: string[]): Finding => ({
    kind: 'DUPLICATE_INVOICE',
    supplierName: 'Nova',
    documentNumber: '1',
    total,
    evidenceDocumentIds: docs,
  });
  const crossSupplier = (percent: string, docs: string[]): Finding => ({
    kind: 'CROSS_SUPPLIER_PRICE',
    productName: 'Butter',
    cheaperSupplierName: 'Nova',
    pricierSupplierName: 'Aurora',
    percentDifference: percent,
    packSize: '1',
    packUnitCode: 'kg',
    evidenceDocumentIds: docs,
  });

  it('ranks real dollar-impact findings first, by magnitude, ahead of percent-only findings', () => {
    const ranked = rankFindings([
      crossSupplier('50.0', ['d']),
      priceChange('100.00', ['a']),
      duplicate('340.00', ['b']),
    ]);
    expect(ranked[0]!.kind).toBe('DUPLICATE_INVOICE');
    expect(ranked[1]!.kind).toBe('PRICE_CHANGE');
    expect(ranked[2]!.kind).toBe('CROSS_SUPPLIER_PRICE');
  });

  it('ranks a price-change finding with a real dollar impact ahead of one with an honest null impact', () => {
    const withImpact = priceChange('1.00', ['a']);
    const withoutImpact: Finding = { ...priceChange('1.00', ['b']), annualizedImpact: null };
    const ranked = rankFindings([withoutImpact, withImpact]);
    expect(ranked[0]).toBe(withImpact);
    expect(ranked[1]).toBe(withoutImpact);
  });

  it('produces a stable, deterministic order for ties', () => {
    const a = duplicate('100.00', ['z']);
    const b = duplicate('100.00', ['a']);
    const ranked1 = rankFindings([a, b]);
    const ranked2 = rankFindings([b, a]);
    expect(ranked1).toEqual(ranked2);
  });
});
