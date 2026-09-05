import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  classifyLineMatch,
  highestSeverity,
  computeLineDollarImpact,
  computeMatchDollarImpact,
  DEFAULT_MATCH_TOLERANCES,
  type MatchCandidate,
  type LineForDollarImpact,
} from './three-way-match';

const d = (v: string) => new Decimal(v);

const noCandidate: MatchCandidate = { poUnitPrice: null, receivedQuantity: null, receiptFound: false };

describe('classifyLineMatch', () => {
  it('classifies an exact match as CLEAN', () => {
    const result = classifyLineMatch(
      { quantity: d('10'), unitPrice: d('4.50') },
      { poUnitPrice: d('4.50'), receivedQuantity: d('10'), receiptFound: true }
    );
    expect(result.varianceType).toBe('CLEAN');
    expect(result.varianceSeverity).toBe('NONE');
  });

  it('flags a price variance beyond both tolerances', () => {
    // $50 -> $100: $50 absolute (> $5) and 100% relative (> 2%) — genuinely beyond both.
    const result = classifyLineMatch(
      { quantity: d('10'), unitPrice: d('100') },
      { poUnitPrice: d('50'), receivedQuantity: d('10'), receiptFound: true }
    );
    expect(result.varianceType).toBe('PRICE_VARIANCE');
    expect(result.varianceSeverity).toBe('MEDIUM');
    expect(result.priceVariance?.toString()).toBe('50');
  });

  it('auto-accepts a price variance within the $5 absolute tolerance even if the percentage is large', () => {
    // A cheap item, e.g. $0.50 -> $4.50: 800% off but within $5 absolute — still CLEAN,
    // to avoid alert fatigue on cents.
    const result = classifyLineMatch(
      { quantity: d('1'), unitPrice: d('4.50') },
      { poUnitPrice: d('0.50'), receivedQuantity: d('1'), receiptFound: true }
    );
    expect(result.varianceType).toBe('CLEAN');
  });

  it('auto-accepts a price variance within the 2% relative tolerance even if it exceeds $5 absolute', () => {
    // $500 -> $505: $5 exactly at the absolute boundary AND exactly 1% — still within either tolerance.
    const result = classifyLineMatch(
      { quantity: d('1'), unitPrice: d('505') },
      { poUnitPrice: d('500'), receivedQuantity: d('1'), receiptFound: true }
    );
    expect(result.varianceType).toBe('CLEAN');
  });

  it('flags a quantity variance beyond tolerance', () => {
    const result = classifyLineMatch(
      { quantity: d('12'), unitPrice: d('4.50') },
      { poUnitPrice: d('4.50'), receivedQuantity: d('10'), receiptFound: true }
    );
    expect(result.varianceType).toBe('QUANTITY_VARIANCE');
    expect(result.quantityVariance?.toString()).toBe('2');
  });

  it('reports PRICE_VARIANCE as the type when both price and quantity vary, but keeps both messages', () => {
    const result = classifyLineMatch(
      { quantity: d('12'), unitPrice: d('100') },
      { poUnitPrice: d('50'), receivedQuantity: d('10'), receiptFound: true }
    );
    expect(result.varianceType).toBe('PRICE_VARIANCE');
    expect(result.priceVariance?.toString()).toBe('50');
    expect(result.quantityVariance?.toString()).toBe('2');
    expect(result.explanation).toContain('unit price');
    expect(result.explanation).toContain('quantity');
  });

  it('flags INVOICED_NOT_RECEIVED as HIGH severity when a PO line matched but no receipt exists', () => {
    const result = classifyLineMatch(
      { quantity: d('10'), unitPrice: d('4.50') },
      { poUnitPrice: d('4.50'), receivedQuantity: null, receiptFound: false }
    );
    expect(result.varianceType).toBe('INVOICED_NOT_RECEIVED');
    expect(result.varianceSeverity).toBe('HIGH');
  });

  it('flags UNORDERED_ITEM when neither a PO line nor a receipt line matched', () => {
    const result = classifyLineMatch({ quantity: d('10'), unitPrice: d('4.50') }, noCandidate);
    expect(result.varianceType).toBe('UNORDERED_ITEM');
    expect(result.varianceSeverity).toBe('MEDIUM');
  });

  it('flags UNORDERED_ITEM (never CLEAN or a fabricated 0) for an unparseable invoice line — I7', () => {
    const result = classifyLineMatch({ quantity: null, unitPrice: d('4.50') }, noCandidate);
    expect(result.varianceType).toBe('UNORDERED_ITEM');
    expect(result.priceVariance).toBeNull();
    expect(result.quantityVariance).toBeNull();
  });

  it('a receipt found with 0 received quantity is NOT the same as no receipt at all', () => {
    const result = classifyLineMatch(
      { quantity: d('10'), unitPrice: d('4.50') },
      { poUnitPrice: d('4.50'), receivedQuantity: d('0'), receiptFound: true }
    );
    expect(result.varianceType).toBe('QUANTITY_VARIANCE');
    expect(result.varianceSeverity).toBe('MEDIUM');
  });

  it('respects injected tolerances over the defaults', () => {
    const tightTolerances = { ...DEFAULT_MATCH_TOLERANCES, priceToleranceAbsolute: new Decimal('0'), priceTolerancePercent: new Decimal('0') };
    const result = classifyLineMatch(
      { quantity: d('1'), unitPrice: d('4.51') },
      { poUnitPrice: d('4.50'), receivedQuantity: d('1'), receiptFound: true },
      tightTolerances
    );
    expect(result.varianceType).toBe('PRICE_VARIANCE');
  });
});

describe('highestSeverity', () => {
  it('returns the worst severity among a set of lines', () => {
    expect(highestSeverity(['NONE', 'MEDIUM', 'HIGH', 'LOW'])).toBe('HIGH');
    expect(highestSeverity(['NONE', 'NONE'])).toBe('NONE');
    expect(highestSeverity([])).toBe('NONE');
  });
});

describe('computeLineDollarImpact', () => {
  it('CLEAN has zero exposure', () => {
    const line: LineForDollarImpact = { varianceType: 'CLEAN', priceVariance: null, quantityVariance: null, invoiceQuantity: d('10'), invoiceUnitPrice: d('4.50') };
    expect(computeLineDollarImpact(line)?.toString()).toBe('0');
  });

  it('PRICE_VARIANCE prices the per-unit variance across the whole invoiced quantity', () => {
    // $50/unit overcharge on 10 units invoiced -> $500 real exposure, not just $50.
    const line: LineForDollarImpact = { varianceType: 'PRICE_VARIANCE', priceVariance: d('50'), quantityVariance: null, invoiceQuantity: d('10'), invoiceUnitPrice: d('100') };
    expect(computeLineDollarImpact(line)?.toString()).toBe('500');
  });

  it('PRICE_VARIANCE is signed — a negative priceVariance (undercharge) is a real negative exposure, a credit owed to the operator', () => {
    const line: LineForDollarImpact = { varianceType: 'PRICE_VARIANCE', priceVariance: d('-2'), quantityVariance: null, invoiceQuantity: d('10'), invoiceUnitPrice: d('48') };
    expect(computeLineDollarImpact(line)?.toString()).toBe('-20');
  });

  it('QUANTITY_VARIANCE prices the extra/short quantity at what was actually invoiced per unit', () => {
    // Invoiced 3 more than received, at $4.50/unit -> $13.50 real exposure.
    const line: LineForDollarImpact = { varianceType: 'QUANTITY_VARIANCE', priceVariance: null, quantityVariance: d('3'), invoiceQuantity: d('13'), invoiceUnitPrice: d('4.50') };
    expect(computeLineDollarImpact(line)?.toString()).toBe('13.5');
  });

  it('UNORDERED_ITEM prices the ENTIRE invoiced line, not a partial variance — there is nothing to compare against', () => {
    const line: LineForDollarImpact = { varianceType: 'UNORDERED_ITEM', priceVariance: null, quantityVariance: null, invoiceQuantity: d('5'), invoiceUnitPrice: d('20') };
    expect(computeLineDollarImpact(line)?.toString()).toBe('100');
  });

  it('INVOICED_NOT_RECEIVED prices the ENTIRE invoiced line — possible fraud/error, full exposure', () => {
    const line: LineForDollarImpact = { varianceType: 'INVOICED_NOT_RECEIVED', priceVariance: null, quantityVariance: null, invoiceQuantity: d('8'), invoiceUnitPrice: d('12.50') };
    expect(computeLineDollarImpact(line)?.toString()).toBe('100');
  });

  it('returns null (never a fabricated 0) when the formula\'s own required inputs are missing (I7)', () => {
    const missingPriceVariance: LineForDollarImpact = { varianceType: 'PRICE_VARIANCE', priceVariance: null, quantityVariance: null, invoiceQuantity: d('10'), invoiceUnitPrice: d('4.50') };
    expect(computeLineDollarImpact(missingPriceVariance)).toBeNull();

    const missingInvoiceQuantity: LineForDollarImpact = { varianceType: 'UNORDERED_ITEM', priceVariance: null, quantityVariance: null, invoiceQuantity: null, invoiceUnitPrice: d('4.50') };
    expect(computeLineDollarImpact(missingInvoiceQuantity)).toBeNull();
  });
});

describe('computeMatchDollarImpact', () => {
  it('sums every line\'s real impact', () => {
    const lines: LineForDollarImpact[] = [
      { varianceType: 'PRICE_VARIANCE', priceVariance: d('10'), quantityVariance: null, invoiceQuantity: d('5'), invoiceUnitPrice: d('20') }, // 50
      { varianceType: 'CLEAN', priceVariance: null, quantityVariance: null, invoiceQuantity: d('3'), invoiceUnitPrice: d('9') }, // 0
      { varianceType: 'UNORDERED_ITEM', priceVariance: null, quantityVariance: null, invoiceQuantity: d('2'), invoiceUnitPrice: d('15') }, // 30
    ];
    expect(computeMatchDollarImpact(lines)?.toString()).toBe('80');
  });

  it('a real partial sum survives one unknown line, rather than the whole total becoming unknown (I7)', () => {
    const lines: LineForDollarImpact[] = [
      { varianceType: 'PRICE_VARIANCE', priceVariance: d('10'), quantityVariance: null, invoiceQuantity: d('5'), invoiceUnitPrice: d('20') }, // 50, known
      { varianceType: 'PRICE_VARIANCE', priceVariance: null, quantityVariance: null, invoiceQuantity: d('1'), invoiceUnitPrice: d('1') }, // unknown — missing priceVariance
    ];
    expect(computeMatchDollarImpact(lines)?.toString()).toBe('50');
  });

  it('is null only when EVERY line is unknown', () => {
    const lines: LineForDollarImpact[] = [
      { varianceType: 'PRICE_VARIANCE', priceVariance: null, quantityVariance: null, invoiceQuantity: d('1'), invoiceUnitPrice: d('1') },
    ];
    expect(computeMatchDollarImpact(lines)).toBeNull();
  });

  it('is a real zero (not null) for an empty line list', () => {
    expect(computeMatchDollarImpact([])?.toString()).toBe('0');
  });
});
