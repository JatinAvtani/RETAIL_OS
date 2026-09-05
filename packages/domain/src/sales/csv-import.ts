import { createHash } from 'node:crypto';
import Papa from 'papaparse';
import { Decimal } from 'decimal.js';
import type { CurrencyCode } from '../primitives/currency.js';

/**
 * CSV import's own pure parsing/mapping layer — no database, no S3, no
 * network. `packages/domain` never imports a database type, so the byte-level upload/storage
 * mechanics (packages/storage, apps/api) stay entirely separate from the deterministic logic of
 * turning raw bytes into row objects and row objects into the same canonical shape Square's own
 * sync produces (I5: money is `Decimal`-backed the moment it leaves this file, never a raw float).
 *
 * CSV only, not XLSX — confirmed with the user: XLSX's binary format and Excel's own date-serial
 * quirks are a genuinely separate parsing problem, deferred to a later task rather than doubling
 * this one's scope.
 */

/** UTF-8 BOM (EF BB BF) — Excel's own CSV export writes this; Papa Parse doesn't strip it automatically. */
const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** Every currency this codebase's `CurrencyCode` union actually accepts — kept in sync with `primitives/currency.ts` by hand, matching this file's own unit-code validation precedent. */
const REAL_CURRENCY_CODES = ['USD', 'EUR', 'GBP', 'INR'] as const;

export type DetectedCsvHeaders = {
  headers: string[];
  /** First few DATA rows (never the header row itself), raw string cells — the mapping UI's own preview, before any column mapping is applied. */
  sampleRows: string[][];
  delimiter: string;
};

export class CsvParseError extends Error {
  constructor(reason: string) {
    super(`CSV could not be parsed: ${reason}`);
    this.name = 'CsvParseError';
  }
}

const MAX_PREVIEW_ROWS = 20;

/**
 * Header + delimiter detection.
 * Encoding is assumed UTF-8 (BOM-stripped) — this codebase's no-card/no-cost, portfolio-scope
 * constraints rule out a full encoding-detection dependency for scope this narrow; a non-UTF-8 file
 * fails at parse time with a clear error rather than silently mis-decoding (I7's "unknown, never a
 * guess" applied to encoding, not just business numbers).
 */
export const detectCsvHeaders = (rawText: string): DetectedCsvHeaders => {
  const text = stripBom(rawText);
  const result = Papa.parse<string[]>(text, { skipEmptyLines: true, preview: MAX_PREVIEW_ROWS + 1 });
  if (result.errors.length > 0) {
    throw new CsvParseError(result.errors[0]!.message);
  }
  const rows = result.data;
  const headers = rows[0];
  if (!headers || headers.length === 0) {
    throw new CsvParseError('no header row found');
  }
  return {
    headers,
    sampleRows: rows.slice(1, MAX_PREVIEW_ROWS + 1),
    delimiter: result.meta.delimiter,
  };
};

/**
 * The mapping UI's own output: which source column (by header text, not index — resilient to
 * column reordering between a tenant's repeat exports) holds each field this codebase needs. Only
 * the fields genuinely required to produce a `sales_transactions`/`salesTransactionLines` row are
 * mandatory; everything else stays unmapped rather than guessed.
 */
export type CsvColumnMapping = {
  occurredAt: string;
  posItemName: string;
  quantity: string;
  unitPrice: string;
  /** Optional — a flat export with no separate discount column is common; absent means "no discount", not "unknown discount" (a real $0, not a missing fact — the CSV's own silence on the column is the fact). */
  discount?: string;
  /** Optional — a per-line total column, when present, is trusted over quantity*unitPrice (matches the codebase's existing "vendor's own number, never recomputed" rule for sales_transactions). */
  lineTotal?: string;
  currency?: string;
};

export type ParsedCsvRow = {
  rowIndex: number;
  occurredAt: Date;
  posItemName: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  lineTotal: string;
  currency: CurrencyCode;
  /** Deterministic per-row idempotency key — a content hash, not a vendor id (none exists for a CSV row). Re-uploading the identical file produces identical hashes; onConflictDoNothing on (organization_id, source, external_id) makes a re-upload a genuine no-op, the same guarantee Square's own order id provides. */
  externalId: string;
};

export type CsvRowIssue = { rowIndex: number; reason: string };

export type ParsedCsvResult = {
  rows: ParsedCsvRow[];
  issues: CsvRowIssue[];
};

/**
 * Strips thousands separators and a leading currency symbol from a numeric cell — the plan's own
 * named encoding-chaos list ("currency symbols, thousands separators"). Deliberately narrow: only
 * `$`/`€`/`£` and comma-as-thousands-separator are handled, matching this codebase's currently
 * supported `CurrencyCode` set (USD/EUR/GBP/INR) — a cell this can't confidently parse becomes a
 * row issue, never a guessed number (I7).
 */
const parseNumericCell = (raw: string): Decimal | null => {
  const cleaned = raw.trim().replace(/[$€£,]/g, '');
  if (cleaned.length === 0) return null;
  try {
    const value = new Decimal(cleaned);
    return value.isFinite() ? value : null;
  } catch {
    return null;
  }
};

/**
 * Excel's own CSV export writes dates as `MM/DD/YYYY` or `YYYY-MM-DD` depending on locale/version —
 * both are tried; anything else is a row issue rather than a guessed date (I7). Deliberately does
 * NOT attempt Excel's numeric date-serial format (a raw integer like `45123`) — that's a genuinely
 * XLSX-specific concern (Excel only serializes dates that way inside its own binary format, never
 * inside a real CSV export), out of scope for this CSV-only task.
 */
const parseDateCell = (raw: string): Date | null => {
  const trimmed = raw.trim();
  const isoMatch = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.exec(trimmed);
  if (isoMatch) {
    const parsed = new Date(trimmed.replace(' ', 'T'));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

const computeRowExternalId = (fields: {
  occurredAt: string;
  posItemName: string;
  quantity: string;
  lineTotal: string;
  rowIndex: number;
}): string =>
  createHash('sha256')
    .update(`${fields.occurredAt}|${fields.posItemName}|${fields.quantity}|${fields.lineTotal}|${fields.rowIndex}`)
    .digest('hex');

/**
 * Applies a confirmed `CsvColumnMapping` to every DATA row (never the header) and produces the
 * canonical row shape `apps/api`'s orchestration writes into `sales_transactions`/
 * `salesTransactionLines`. A row that fails to parse (missing required cell, unparseable
 * date/number) becomes an issue, not a thrown error and not a guessed value — the whole file still
 * imports, matching the plan's Phase 3 "schema validation quarantines the WHOLE BATCH on failure"
 * language applied at the granularity that actually matches a spreadsheet: one bad row shouldn't
 * discard 500 good ones, but a row this function can't confidently parse must never silently become
 * a wrong number either.
 */
export const parseCsvRows = (
  rawText: string,
  headers: string[],
  mapping: CsvColumnMapping,
  defaultCurrency: CurrencyCode
): ParsedCsvResult => {
  const text = stripBom(rawText);
  const result = Papa.parse<string[]>(text, { skipEmptyLines: true });
  if (result.errors.length > 0) {
    throw new CsvParseError(result.errors[0]!.message);
  }
  const dataRows = result.data.slice(1); // row 0 is always the header, matching detectCsvHeaders

  const columnIndex = (headerName: string): number => headers.indexOf(headerName);
  const occurredAtIdx = columnIndex(mapping.occurredAt);
  const posItemNameIdx = columnIndex(mapping.posItemName);
  const quantityIdx = columnIndex(mapping.quantity);
  const unitPriceIdx = columnIndex(mapping.unitPrice);
  const discountIdx = mapping.discount !== undefined ? columnIndex(mapping.discount) : -1;
  const lineTotalIdx = mapping.lineTotal !== undefined ? columnIndex(mapping.lineTotal) : -1;
  const currencyIdx = mapping.currency !== undefined ? columnIndex(mapping.currency) : -1;

  if ([occurredAtIdx, posItemNameIdx, quantityIdx, unitPriceIdx].some((idx) => idx === -1)) {
    throw new CsvParseError('column mapping references a header that does not exist in this file');
  }

  const rows: ParsedCsvRow[] = [];
  const issues: CsvRowIssue[] = [];

  dataRows.forEach((cells, i) => {
    const rowIndex = i + 1; // 1-based, matching the file's own visible row numbering (row 0 is the header)

    const occurredAtRaw = cells[occurredAtIdx];
    const posItemName = cells[posItemNameIdx]?.trim();
    const quantityRaw = cells[quantityIdx];
    const unitPriceRaw = cells[unitPriceIdx];

    if (!occurredAtRaw || !posItemName || !quantityRaw || !unitPriceRaw) {
      issues.push({ rowIndex, reason: 'missing a required field' });
      return;
    }

    const occurredAt = parseDateCell(occurredAtRaw);
    if (!occurredAt) {
      issues.push({ rowIndex, reason: `unparseable date '${occurredAtRaw}'` });
      return;
    }

    const quantity = parseNumericCell(quantityRaw);
    if (!quantity) {
      issues.push({ rowIndex, reason: `unparseable quantity '${quantityRaw}'` });
      return;
    }

    const unitPrice = parseNumericCell(unitPriceRaw);
    if (!unitPrice) {
      issues.push({ rowIndex, reason: `unparseable unit price '${unitPriceRaw}'` });
      return;
    }

    const discountRaw = discountIdx !== -1 ? cells[discountIdx] : undefined;
    const discount = discountRaw ? parseNumericCell(discountRaw) : new Decimal(0);
    if (!discount) {
      issues.push({ rowIndex, reason: `unparseable discount '${discountRaw}'` });
      return;
    }

    const lineTotalRaw = lineTotalIdx !== -1 ? cells[lineTotalIdx] : undefined;
    const lineTotal = lineTotalRaw ? parseNumericCell(lineTotalRaw) : quantity.times(unitPrice).minus(discount);
    if (!lineTotal) {
      issues.push({ rowIndex, reason: `unparseable line total '${lineTotalRaw}'` });
      return;
    }

    const currencyRaw = currencyIdx !== -1 ? cells[currencyIdx]?.trim().toUpperCase() : undefined;
    if (currencyRaw && !(REAL_CURRENCY_CODES as readonly string[]).includes(currencyRaw)) {
      issues.push({ rowIndex, reason: `unrecognized currency '${currencyRaw}' — must be one of ${REAL_CURRENCY_CODES.join(', ')}` });
      return;
    }
    const currency = (currencyRaw as CurrencyCode | undefined) ?? defaultCurrency;

    const quantityStr = quantity.toFixed(6);
    const lineTotalStr = lineTotal.toFixed(4);

    rows.push({
      rowIndex,
      occurredAt,
      posItemName,
      quantity: quantityStr,
      unitPrice: unitPrice.toFixed(4),
      discount: discount.toFixed(4),
      lineTotal: lineTotalStr,
      currency,
      externalId: computeRowExternalId({
        occurredAt: occurredAt.toISOString(),
        posItemName,
        quantity: quantityStr,
        lineTotal: lineTotalStr,
        rowIndex,
      }),
    });
  });

  return { rows, issues };
};
