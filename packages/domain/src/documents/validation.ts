import { Decimal } from 'decimal.js';

/**
 * the plan — "the anti-hallucination layer." Every check here is deterministic
 * arithmetic/comparison (I1): the model that produced the extraction is never asked to verify its
 * own numbers, and nothing here computes a business number that gets posted anywhere — it only
 * flags whether the RAW extracted values are internally consistent enough to trust.
 *
 * Extracted values arrive as raw strings (`ExtractedField.value: string | null` from
 * `packages/ai`'s `ExtractionResult`) — OCR/vision output, not yet parsed. A field that fails to
 * parse as a number/date is treated as UNKNOWN, never coerced to 0 or "now" (I7): a gate simply
 * cannot evaluate without a value it can trust, so it skips silently rather than fabricating a
 * pass or a false alarm.
 */

export type IssueSeverity = 'BLOCK' | 'WARN';

export interface ValidationIssue {
  severity: IssueSeverity;
  code:
    | 'LINE_ARITHMETIC'
    | 'TOTAL_MISMATCH'
    | 'DUPLICATE'
    | 'DATE_IMPLAUSIBLE'
    | 'PRICE_ANOMALY'
    | 'PRICE_CHECK_UNAVAILABLE';
  field: string;
  message: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  canAutoApprove: boolean;
}

/** Mirrors `packages/ai`'s `ExtractedField` shape without importing it — domain stays I/O-free and provider-agnostic. */
export interface RawField {
  value: string | null;
}

export interface RawLine {
  sku: RawField;
  description: RawField;
  quantity: RawField;
  unit: RawField;
  unitPrice: RawField;
  lineTotal: RawField;
}

export interface RawFields {
  supplier: RawField;
  documentNumber: RawField;
  documentDate: RawField;
  currency: RawField;
  subtotal: RawField;
  tax: RawField;
  discount: RawField;
  total: RawField;
}

/** A prior document sharing either the same content hash or the same (supplier, documentNumber) pair — enough for the duplicate gate to decide, nothing more. */
export interface DuplicateCandidate {
  documentId: string;
  matchedOn: 'CONTENT_HASH' | 'SUPPLIER_AND_DOCUMENT_NUMBER';
}

/** One real, confirmed prior unit price for the same supplier+SKU — the price-anomaly gate's comparison set. Only ever built from `supplierProducts.isConfirmed = true` rows (see repository layer); an unconfirmed or fuzzy-matched mapping never reaches this function. */
export interface TrailingPrice {
  unitPrice: Decimal;
}

export interface ValidationContext {
  /** Prior documents matching this one by content hash or by (supplier, documentNumber) — already looked up by the caller. Empty array means "no duplicate found," not "not checked." */
  duplicateCandidates: DuplicateCandidate[];
  /** Confirmed trailing prices for one extracted line's (supplier, sku), keyed by line index. A line with no entry (or an empty array) means no confirmed price history exists — the gate produces no signal for it, never a fabricated anomaly or a fabricated pass. */
  trailingPricesByLineIndex: Map<number, TrailingPrice[]>;
  /**
   * Whether the caller was able to resolve the extracted supplier name to a real supplier row at
   * all — `false` when `findByExactName` found zero or more-than-one match (any OCR variance in
   * the supplier name silently skips price-anomaly checking otherwise, with zero issues raised, and
   * the document can reach AUTO_APPROVE having never actually been checked). `trailingPricesByLineIndex`
   * being empty is genuinely ambiguous on its own — "supplier resolved, no price history yet" and
   * "supplier never resolved, gate never ran" must not look the same to a human reviewer.
   */
  supplierResolved: boolean;
  /** Injected so the date-plausibility gate is deterministic and testable — never `new Date()` inline. */
  today: Date;
}

const AMOUNT_TOLERANCE = new Decimal('0.01');
const TOTAL_TOLERANCE = new Decimal('0.02');
const MAX_DOCUMENT_AGE_MONTHS = 24;
const PRICE_ANOMALY_MULTIPLE = new Decimal(5);

/** Parses a raw extracted string as a Decimal. Returns `null` (never 0) for anything unparseable — a genuinely missing or garbled field cannot participate in arithmetic checks, per I7. */
const parseDecimal = (raw: string | null): Decimal | null => {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const normalized = trimmed.replace(/[,$€£]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const value = new Decimal(normalized);
  return value.isFinite() ? value : null;
};

/** Parses a raw extracted date string. Returns `null` for anything unparseable or ambiguous — never "now" or an arbitrary fallback. */
const parseDate = (raw: string | null): Date | null => {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const monthsBefore = (date: Date, months: number): Date => {
  const result = new Date(date.getTime());
  result.setUTCMonth(result.getUTCMonth() - months);
  return result;
};

/**
 * Line arithmetic: `quantity * unitPrice` must match `lineTotal` within tolerance. A line missing
 * any of the three parseable values is skipped, not flagged — an OCR miss on `quantity` is a
 * confidence/completeness problem the routing gate handles, not an arithmetic error this
 * gate can even evaluate.
 */
const checkLineArithmetic = (lines: RawLine[]): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  lines.forEach((line, index) => {
    const qty = parseDecimal(line.quantity.value);
    const unitPrice = parseDecimal(line.unitPrice.value);
    const lineTotal = parseDecimal(line.lineTotal.value);
    if (qty === null || unitPrice === null || lineTotal === null) return;

    const expected = qty.times(unitPrice);
    if (expected.minus(lineTotal).abs().greaterThan(AMOUNT_TOLERANCE)) {
      issues.push({
        severity: 'BLOCK',
        code: 'LINE_ARITHMETIC',
        field: `lines[${index}]`,
        message: `Line ${index + 1}: quantity (${qty.toString()}) x unit price (${unitPrice.toString()}) = ${expected.toFixed(2)}, but the extracted line total is ${lineTotal.toFixed(2)}.`,
      });
    }
  });
  return issues;
};

/**
 * Document total: sum(line totals) + tax - discount must match the extracted `total`. Only lines
 * with a parseable `lineTotal` contribute to the sum; if ANY line's total is unparseable, the sum
 * itself is unknown and this gate is skipped entirely rather than comparing against a partial sum
 * (a partial sum silently understating the real total is exactly the "degrades to zero" failure
 * I7 forbids).
 */
const checkDocumentTotal = (fields: RawFields, lines: RawLine[]): ValidationIssue[] => {
  const total = parseDecimal(fields.total.value);
  if (total === null) return [];

  const lineTotals: Decimal[] = [];
  for (const line of lines) {
    const lineTotal = parseDecimal(line.lineTotal.value);
    if (lineTotal === null) return []; // one unparseable line total makes the whole sum unknown
    lineTotals.push(lineTotal);
  }

  const tax = parseDecimal(fields.tax.value) ?? new Decimal(0);
  const discount = parseDecimal(fields.discount.value) ?? new Decimal(0);
  const sumOfLines = lineTotals.reduce((acc, t) => acc.plus(t), new Decimal(0));
  const expectedTotal = sumOfLines.plus(tax).minus(discount);

  if (expectedTotal.minus(total).abs().greaterThan(TOTAL_TOLERANCE)) {
    return [
      {
        severity: 'BLOCK',
        code: 'TOTAL_MISMATCH',
        field: 'total',
        message: `Line totals (${sumOfLines.toFixed(2)}) + tax (${tax.toFixed(2)}) - discount (${discount.toFixed(2)}) = ${expectedTotal.toFixed(2)}, but the extracted document total is ${total.toFixed(2)}.`,
      },
    ];
  }
  return [];
};

/** Duplicate detection: any prior candidate at all blocks — the caller already did the real lookup (content hash / supplier+documentNumber); this just turns "found something" into an issue. */
const checkDuplicate = (candidates: DuplicateCandidate[]): ValidationIssue[] =>
  candidates.map((candidate) => ({
    severity: 'BLOCK' as const,
    code: 'DUPLICATE' as const,
    field: candidate.matchedOn === 'CONTENT_HASH' ? 'contentHash' : 'documentNumber',
    message:
      candidate.matchedOn === 'CONTENT_HASH'
        ? `This exact file was already uploaded as document ${candidate.documentId}.`
        : `A document from the same supplier with the same document number already exists (${candidate.documentId}).`,
  }));

/** Date plausibility: a future date or one older than 24 months is a WARN, not a BLOCK — plausible but worth a human glance, per the plan. An unparseable date is skipped, not flagged. */
const checkDatePlausibility = (fields: RawFields, today: Date): ValidationIssue[] => {
  const docDate = parseDate(fields.documentDate.value);
  if (docDate === null) return [];

  if (docDate.getTime() > today.getTime()) {
    return [
      {
        severity: 'WARN',
        code: 'DATE_IMPLAUSIBLE',
        field: 'documentDate',
        message: `Document date (${docDate.toISOString().slice(0, 10)}) is in the future.`,
      },
    ];
  }
  if (docDate.getTime() < monthsBefore(today, MAX_DOCUMENT_AGE_MONTHS).getTime()) {
    return [
      {
        severity: 'WARN',
        code: 'DATE_IMPLAUSIBLE',
        field: 'documentDate',
        message: `Document date (${docDate.toISOString().slice(0, 10)}) is more than ${MAX_DOCUMENT_AGE_MONTHS} months old.`,
      },
    ];
  }
  return [];
};

/**
 * Price anomaly: an extracted unit price more than 5x above or below the median of confirmed
 * trailing prices for the same supplier+SKU — the highest-value gate per the plan, since a
 * decimal-place OCR slip (e.g. $4.50 read as $45.00) is the most common and most damaging failure
 * class. A line with no confirmed trailing prices produces no issue at all (not a pass, not a
 * fail) — there being no comparison data is itself an "unknown," not evidence of correctness.
 */
const checkPriceAnomaly = (lines: RawLine[], trailingPricesByLineIndex: Map<number, TrailingPrice[]>, supplierResolved: boolean): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];

  // The supplier name never resolved to a real row at all (OCR variance, or a genuinely new
  // supplier) — every line's price-anomaly check was skipped, not "passed." A WARN per line with a
  // SKU makes that visible to a human reviewer instead of a silently-clean-looking result.
  if (!supplierResolved) {
    lines.forEach((line, index) => {
      if (line.sku.value === null) return;
      issues.push({
        severity: 'WARN',
        code: 'PRICE_CHECK_UNAVAILABLE',
        field: `lines[${index}].unitPrice`,
        message: `Line ${index + 1}: price-anomaly check did not run — the extracted supplier name did not resolve to exactly one known supplier.`,
      });
    });
    return issues;
  }

  lines.forEach((line, index) => {
    const unitPrice = parseDecimal(line.unitPrice.value);
    if (unitPrice === null) return;

    const trailing = trailingPricesByLineIndex.get(index);
    if (!trailing || trailing.length === 0) return;

    const median = medianOf(trailing.map((t) => t.unitPrice));
    if (median.isZero()) return; // a zero median gives no meaningful ratio either direction

    const upperBound = median.times(PRICE_ANOMALY_MULTIPLE);
    const lowerBound = median.dividedBy(PRICE_ANOMALY_MULTIPLE);
    if (unitPrice.greaterThan(upperBound) || unitPrice.lessThan(lowerBound)) {
      issues.push({
        severity: 'BLOCK',
        code: 'PRICE_ANOMALY',
        field: `lines[${index}].unitPrice`,
        message: `Line ${index + 1}: unit price ${unitPrice.toFixed(4)} is more than 5x away from this supplier/SKU's trailing median (${median.toFixed(4)}).`,
      });
    }
  });
  return issues;
};

const medianOf = (values: Decimal[]): Decimal => {
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  const middle = sorted[mid];
  if (middle === undefined) {
    throw new Error('medianOf called with an empty array.');
  }
  if (sorted.length % 2 === 1) return middle;
  const lower = sorted[mid - 1];
  if (lower === undefined) {
    throw new Error('medianOf: even-length array missing its lower-middle element.');
  }
  return lower.plus(middle).dividedBy(2);
};

/**
 * Runs every gate and combines their issues. `canAutoApprove` is false whenever any BLOCK-severity
 * issue exists — WARN issues alone don't block auto-approval (earlier work's routing gate also folds in
 * confidence, which this function knows nothing about; this is arithmetic/consistency only).
 */
export const validateExtraction = (fields: RawFields, lines: RawLine[], context: ValidationContext): ValidationResult => {
  const issues: ValidationIssue[] = [
    ...checkLineArithmetic(lines),
    ...checkDocumentTotal(fields, lines),
    ...checkDuplicate(context.duplicateCandidates),
    ...checkDatePlausibility(fields, context.today),
    ...checkPriceAnomaly(lines, context.trailingPricesByLineIndex, context.supplierResolved),
  ];
  return { issues, canAutoApprove: !issues.some((issue) => issue.severity === 'BLOCK') };
};
