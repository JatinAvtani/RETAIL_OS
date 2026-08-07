import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  validateExtraction,
  type RawFields,
  type RawLine,
  type ValidationContext,
} from './validation';

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

const baseContext = (overrides: Partial<ValidationContext> = {}): ValidationContext => ({
  duplicateCandidates: [],
  trailingPricesByLineIndex: new Map(),
  today: new Date('2026-08-07T00:00:00Z'),
  ...overrides,
});

describe('validateExtraction — line arithmetic (LINE_ARITHMETIC)', () => {
  it('passes when quantity x unitPrice matches lineTotal exactly', () => {
    const line = { ...emptyLine(), quantity: field('4'), unitPrice: field('2.50'), lineTotal: field('10.00') };
    const result = validateExtraction(emptyFields(), [line], baseContext());
    expect(result.issues).toHaveLength(0);
    expect(result.canAutoApprove).toBe(true);
  });

  it('passes within the 0.01 tolerance (rounding)', () => {
    const line = { ...emptyLine(), quantity: field('3'), unitPrice: field('3.335'), lineTotal: field('10.01') };
    const result = validateExtraction(emptyFields(), [line], baseContext());
    expect(result.issues).toHaveLength(0);
  });

  it('flags a BLOCK when quantity x unitPrice does not match lineTotal', () => {
    const line = { ...emptyLine(), quantity: field('4'), unitPrice: field('2.50'), lineTotal: field('45.00') };
    const result = validateExtraction(emptyFields(), [line], baseContext());
    expect(result.issues).toEqual([
      expect.objectContaining({ severity: 'BLOCK', code: 'LINE_ARITHMETIC', field: 'lines[0]' }),
    ]);
    expect(result.canAutoApprove).toBe(false);
  });

  it('skips a line with an unparseable quantity rather than flagging or treating it as zero', () => {
    const line = { ...emptyLine(), quantity: field('illegible'), unitPrice: field('2.50'), lineTotal: field('10.00') };
    const result = validateExtraction(emptyFields(), [line], baseContext());
    expect(result.issues).toHaveLength(0);
  });

  it('skips a line missing lineTotal entirely', () => {
    const line = { ...emptyLine(), quantity: field('4'), unitPrice: field('2.50'), lineTotal: field(null) };
    const result = validateExtraction(emptyFields(), [line], baseContext());
    expect(result.issues).toHaveLength(0);
  });

  it('strips thousands separators and currency symbols before parsing', () => {
    const line = { ...emptyLine(), quantity: field('1,000'), unitPrice: field('$2.00'), lineTotal: field('2,000.00') };
    const result = validateExtraction(emptyFields(), [line], baseContext());
    expect(result.issues).toHaveLength(0);
  });
});

describe('validateExtraction — document total (TOTAL_MISMATCH)', () => {
  it('passes when sum(lines) + tax - discount matches total', () => {
    const fields = { ...emptyFields(), tax: field('5.00'), discount: field('2.00'), total: field('13.00') };
    const lines = [
      { ...emptyLine(), lineTotal: field('5.00') },
      { ...emptyLine(), lineTotal: field('5.00') },
    ];
    const result = validateExtraction(fields, lines, baseContext());
    expect(result.issues).toHaveLength(0);
  });

  it('flags a BLOCK when the total does not reconcile', () => {
    const fields = { ...emptyFields(), tax: field('0'), discount: field('0'), total: field('999.00') };
    const lines = [{ ...emptyLine(), lineTotal: field('5.00') }];
    const result = validateExtraction(fields, lines, baseContext());
    expect(result.issues).toEqual([
      expect.objectContaining({ severity: 'BLOCK', code: 'TOTAL_MISMATCH', field: 'total' }),
    ]);
  });

  it('treats a missing tax/discount as zero, not as unknown (they are genuinely optional on many invoices)', () => {
    const fields = { ...emptyFields(), total: field('10.00') };
    const lines = [{ ...emptyLine(), lineTotal: field('10.00') }];
    const result = validateExtraction(fields, lines, baseContext());
    expect(result.issues).toHaveLength(0);
  });

  it('skips entirely when total itself is unparseable', () => {
    const fields = { ...emptyFields(), total: field(null) };
    const lines = [{ ...emptyLine(), lineTotal: field('5.00') }];
    const result = validateExtraction(fields, lines, baseContext());
    expect(result.issues).toHaveLength(0);
  });

  it('skips entirely when any single line total is unparseable, rather than summing a partial set', () => {
    const fields = { ...emptyFields(), total: field('5.00') };
    const lines = [
      { ...emptyLine(), lineTotal: field('5.00') },
      { ...emptyLine(), lineTotal: field(null) },
    ];
    const result = validateExtraction(fields, lines, baseContext());
    expect(result.issues).toHaveLength(0);
  });
});

describe('validateExtraction — duplicate detection (DUPLICATE)', () => {
  it('produces no issue when there are no candidates', () => {
    const result = validateExtraction(emptyFields(), [], baseContext());
    expect(result.issues).toHaveLength(0);
  });

  it('flags a BLOCK for a content-hash match', () => {
    const result = validateExtraction(
      emptyFields(),
      [],
      baseContext({ duplicateCandidates: [{ documentId: 'doc-1', matchedOn: 'CONTENT_HASH' }] })
    );
    expect(result.issues).toEqual([
      expect.objectContaining({ severity: 'BLOCK', code: 'DUPLICATE', field: 'contentHash' }),
    ]);
    expect(result.canAutoApprove).toBe(false);
  });

  it('flags a BLOCK for a supplier+documentNumber match', () => {
    const result = validateExtraction(
      emptyFields(),
      [],
      baseContext({ duplicateCandidates: [{ documentId: 'doc-2', matchedOn: 'SUPPLIER_AND_DOCUMENT_NUMBER' }] })
    );
    expect(result.issues).toEqual([
      expect.objectContaining({ severity: 'BLOCK', code: 'DUPLICATE', field: 'documentNumber' }),
    ]);
  });
});

describe('validateExtraction — date plausibility (DATE_IMPLAUSIBLE)', () => {
  it('passes for a recent, past date', () => {
    const fields = { ...emptyFields(), documentDate: field('2026-08-01') };
    const result = validateExtraction(fields, [], baseContext());
    expect(result.issues).toHaveLength(0);
  });

  it('WARNs (not BLOCK) for a future date, and does not block auto-approval', () => {
    const fields = { ...emptyFields(), documentDate: field('2026-09-01') };
    const result = validateExtraction(fields, [], baseContext());
    expect(result.issues).toEqual([
      expect.objectContaining({ severity: 'WARN', code: 'DATE_IMPLAUSIBLE' }),
    ]);
    expect(result.canAutoApprove).toBe(true);
  });

  it('WARNs for a date more than 24 months old', () => {
    const fields = { ...emptyFields(), documentDate: field('2024-01-01') };
    const result = validateExtraction(fields, [], baseContext());
    expect(result.issues).toEqual([
      expect.objectContaining({ severity: 'WARN', code: 'DATE_IMPLAUSIBLE' }),
    ]);
  });

  it('skips when the date is unparseable', () => {
    const fields = { ...emptyFields(), documentDate: field('not a date') };
    const result = validateExtraction(fields, [], baseContext());
    expect(result.issues).toHaveLength(0);
  });
});

describe('validateExtraction — price anomaly (PRICE_ANOMALY)', () => {
  it('produces no issue when there is no confirmed trailing price history for a line', () => {
    const line = { ...emptyLine(), unitPrice: field('45.00') };
    const result = validateExtraction(emptyFields(), [line], baseContext());
    expect(result.issues).toHaveLength(0);
  });

  it('flags a BLOCK when unit price is more than 5x the trailing median (decimal-place OCR slip)', () => {
    const line = { ...emptyLine(), unitPrice: field('45.00') };
    const context = baseContext({
      trailingPricesByLineIndex: new Map([[0, [{ unitPrice: new Decimal('4.50') }, { unitPrice: new Decimal('4.60') }]]]),
    });
    const result = validateExtraction(emptyFields(), [line], context);
    expect(result.issues).toEqual([
      expect.objectContaining({ severity: 'BLOCK', code: 'PRICE_ANOMALY', field: 'lines[0].unitPrice' }),
    ]);
  });

  it('flags a BLOCK when unit price is more than 5x BELOW the trailing median', () => {
    const line = { ...emptyLine(), unitPrice: field('0.50') };
    const context = baseContext({
      trailingPricesByLineIndex: new Map([[0, [{ unitPrice: new Decimal('4.50') }]]]),
    });
    const result = validateExtraction(emptyFields(), [line], context);
    expect(result.issues).toEqual([
      expect.objectContaining({ severity: 'BLOCK', code: 'PRICE_ANOMALY' }),
    ]);
  });

  it('passes when unit price is within 5x of the trailing median', () => {
    const line = { ...emptyLine(), unitPrice: field('5.00') };
    const context = baseContext({
      trailingPricesByLineIndex: new Map([[0, [{ unitPrice: new Decimal('4.50') }]]]),
    });
    const result = validateExtraction(emptyFields(), [line], context);
    expect(result.issues).toHaveLength(0);
  });

  it('uses the median, not the mean, of multiple trailing prices', () => {
    // median of [1, 1, 100] is 1 -> a price of 5.5 is within 5x of 1? No: 5.5 > 1*5=5, so this SHOULD flag.
    // Chosen to prove it's not using the mean (34, which 5.5 would be nowhere near flagging against).
    const line = { ...emptyLine(), unitPrice: field('5.50') };
    const context = baseContext({
      trailingPricesByLineIndex: new Map([
        [0, [{ unitPrice: new Decimal('1') }, { unitPrice: new Decimal('1') }, { unitPrice: new Decimal('100') }]],
      ]),
    });
    const result = validateExtraction(emptyFields(), [line], context);
    expect(result.issues).toEqual([expect.objectContaining({ code: 'PRICE_ANOMALY' })]);
  });
});

describe('validateExtraction — canAutoApprove', () => {
  it('is false when only a WARN is present alongside no BLOCKs — WARN alone does not block', () => {
    const fields = { ...emptyFields(), documentDate: field('2024-01-01') };
    const result = validateExtraction(fields, [], baseContext());
    expect(result.canAutoApprove).toBe(true);
  });

  it('is false when any BLOCK is present', () => {
    const result = validateExtraction(
      emptyFields(),
      [],
      baseContext({ duplicateCandidates: [{ documentId: 'doc-1', matchedOn: 'CONTENT_HASH' }] })
    );
    expect(result.canAutoApprove).toBe(false);
  });

  it('is true when there are zero issues at all', () => {
    const result = validateExtraction(emptyFields(), [], baseContext());
    expect(result.canAutoApprove).toBe(true);
  });
});
