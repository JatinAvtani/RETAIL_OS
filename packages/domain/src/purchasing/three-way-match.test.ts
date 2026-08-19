import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { classifyLineMatch, highestSeverity, DEFAULT_MATCH_TOLERANCES, type MatchCandidate } from './three-way-match';

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
    // A cheap item, e.g. $0.50 -> $4.50: 800% off but within $5 absolute — still CLEAN per
    // the plan's own "avoid alert fatigue on cents" framing.
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
