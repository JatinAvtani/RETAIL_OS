import { Decimal } from 'decimal.js';
import { detectPriceChange } from '../purchasing/price-change.js';

/**
 * 012-10: "generated once enough invoices are processed... every claim cites its source
 * documents. This report is the product's proof." (plan.md). Pure functions only (I1) — every
 * input here is a real, already-persisted value (a `supplier_performance_events.PRICE_CHANGE` row,
 * real document totals, a real confirmed `supplier_products` price) read by the caller; nothing in
 * this file queries a database or calls a model. No LLM narration in v1: a finding's own citation
 * IS the explanation, so there is nothing a narration step adds that isn't already real and
 * grounded — skipping it also means this report works even when the model quota is exhausted,
 * which this project's own history shows happens often.
 */

export type PriceChangeFinding = {
  kind: 'PRICE_CHANGE';
  supplierName: string;
  productName: string;
  percentChange: string;
  direction: 'up' | 'down';
  /** `null` when no trailing receiving history exists — the finding still names the % change honestly, never a fabricated dollar figure (I7). */
  annualizedImpact: string | null;
  occurredAt: Date;
  evidenceDocumentIds: string[];
};

export type DuplicateInvoiceFinding = {
  kind: 'DUPLICATE_INVOICE';
  supplierName: string;
  documentNumber: string | null;
  /** The total of ONE of the duplicate documents — both share the same content hash, so their totals are identical by construction, never summed (that would double the real number). */
  total: string;
  evidenceDocumentIds: string[];
};

export type CrossSupplierPriceFinding = {
  kind: 'CROSS_SUPPLIER_PRICE';
  productName: string;
  cheaperSupplierName: string;
  pricierSupplierName: string;
  percentDifference: string;
  packSize: string;
  packUnitCode: string;
  evidenceDocumentIds: string[];
};

export type Finding = PriceChangeFinding | DuplicateInvoiceFinding | CrossSupplierPriceFinding;

/**
 * Re-derives the percent change from the SAME real persisted event values a `PRICE_CHANGE`
 * supplier-performance event already carries (`expectedValue`/`actualValue`) via the SAME pure
 * `detectPriceChange` function `PostingService` already calls when it first detects the change
 * (I2) — never a second, independent formula. `expectedValue`/`actualValue` are guaranteed non-null
 * on a real `PRICE_CHANGE` event (the only event type this function accepts); the caller filters to
 * that type before calling this.
 */
export const buildPriceChangeFinding = (input: {
  supplierName: string;
  productName: string;
  expectedValue: string;
  actualValue: string;
  variance: string | null;
  occurredAt: Date;
  evidenceDocumentIds: string[];
}): PriceChangeFinding | null => {
  const result = detectPriceChange({
    oldUnitPrice: new Decimal(input.expectedValue),
    newUnitPrice: new Decimal(input.actualValue),
    trailing12moQuantity: null, // the real annualized figure is already persisted as `variance`; not recomputed here.
  });
  if (result.percentChange === null) return null;

  return {
    kind: 'PRICE_CHANGE',
    supplierName: input.supplierName,
    productName: input.productName,
    percentChange: result.percentChange.times(100).toFixed(1),
    direction: new Decimal(input.actualValue).greaterThan(input.expectedValue) ? 'up' : 'down',
    annualizedImpact: input.variance,
    occurredAt: input.occurredAt,
    evidenceDocumentIds: input.evidenceDocumentIds,
  };
};

/** Groups documents by real content_hash, keeping only groups with 2+ real members — a genuine byte-identical duplicate, the strongest signal this codebase has (never a fuzzy/probabilistic match, I7). */
export const buildDuplicateInvoiceFindings = (
  documents: Array<{
    id: string;
    contentHash: string;
    supplierName: string | null;
    documentNumber: string | null;
    total: string | null;
  }>
): DuplicateInvoiceFinding[] => {
  const byHash = new Map<string, typeof documents>();
  for (const doc of documents) {
    const existing = byHash.get(doc.contentHash);
    if (existing) existing.push(doc);
    else byHash.set(doc.contentHash, [doc]);
  }

  const findings: DuplicateInvoiceFinding[] = [];
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    const representative = group[0]!;
    if (!representative.supplierName || !representative.total) continue; // no real data to cite (I7).
    findings.push({
      kind: 'DUPLICATE_INVOICE',
      supplierName: representative.supplierName,
      documentNumber: representative.documentNumber,
      total: representative.total,
      evidenceDocumentIds: group.map((d) => d.id),
    });
  }
  return findings;
};

/**
 * Compares confirmed supplier prices for the SAME product, ONLY when both quotes share the exact
 * same real `packSize`/`packUnitId` (plan.md's own "for the same pack size" wording) — never
 * converted across units for this comparison (a real I6 risk this function deliberately avoids;
 * a mismatched pack size is not comparable and produces no finding, not a converted guess).
 */
export const buildCrossSupplierPriceFindings = (input: {
  productName: string;
  quotes: Array<{
    supplierName: string;
    unitPrice: string;
    packSize: string | null;
    packUnitCode: string | null;
    evidenceDocumentId: string;
  }>;
}): CrossSupplierPriceFinding[] => {
  const byPackKey = new Map<string, typeof input.quotes>();
  for (const quote of input.quotes) {
    if (!quote.packSize || !quote.packUnitCode) continue; // no real comparable basis (I7).
    const key = `${quote.packSize}:${quote.packUnitCode}`;
    const existing = byPackKey.get(key);
    if (existing) existing.push(quote);
    else byPackKey.set(key, [quote]);
  }

  const findings: CrossSupplierPriceFinding[] = [];
  for (const group of byPackKey.values()) {
    const bySupplier = new Map<string, (typeof group)[number]>();
    for (const quote of group) {
      if (!bySupplier.has(quote.supplierName)) bySupplier.set(quote.supplierName, quote);
    }
    const distinctSuppliers = [...bySupplier.values()];
    if (distinctSuppliers.length < 2) continue;

    const sorted = distinctSuppliers.slice().sort((a, b) => new Decimal(a.unitPrice).comparedTo(b.unitPrice));
    const cheapest = sorted[0]!;
    const priciest = sorted[sorted.length - 1]!;
    if (cheapest.unitPrice === priciest.unitPrice) continue; // no real difference to report.

    const cheapPrice = new Decimal(cheapest.unitPrice);
    if (cheapPrice.isZero()) continue; // an undefined percent difference — no real basis (I7).
    const percentDifference = new Decimal(priciest.unitPrice).minus(cheapPrice).dividedBy(cheapPrice).times(100);

    findings.push({
      kind: 'CROSS_SUPPLIER_PRICE',
      productName: input.productName,
      cheaperSupplierName: cheapest.supplierName,
      pricierSupplierName: priciest.supplierName,
      percentDifference: percentDifference.toFixed(1),
      packSize: cheapest.packSize!,
      packUnitCode: cheapest.packUnitCode!,
      evidenceDocumentIds: [cheapest.evidenceDocumentId, priciest.evidenceDocumentId],
    });
  }
  return findings;
};

/**
 * Real, mechanical ranking — never a model's judgment call (I1). Findings with a real dollar
 * impact rank first, ordered by magnitude; findings with no dollar figure (a duplicate whose total
 * is still a real number, or a cross-supplier percent gap with no absolute dollar impact computed)
 * rank after, ordered by percent magnitude. Ties break on a stable key so re-running produces the
 * identical order.
 */
export const rankFindings = (findings: Finding[]): Finding[] => {
  const dollarValue = (finding: Finding): Decimal | null => {
    if (finding.kind === 'PRICE_CHANGE') return finding.annualizedImpact !== null ? new Decimal(finding.annualizedImpact).abs() : null;
    if (finding.kind === 'DUPLICATE_INVOICE') return new Decimal(finding.total);
    return null;
  };
  const percentValue = (finding: Finding): Decimal => {
    if (finding.kind === 'PRICE_CHANGE') return new Decimal(finding.percentChange);
    if (finding.kind === 'CROSS_SUPPLIER_PRICE') return new Decimal(finding.percentDifference);
    return new Decimal(0);
  };
  const stableKey = (finding: Finding): string => finding.evidenceDocumentIds.slice().sort().join('|');

  return findings.slice().sort((a, b) => {
    const dollarA = dollarValue(a);
    const dollarB = dollarValue(b);
    if (dollarA !== null && dollarB !== null) {
      const cmp = dollarB.comparedTo(dollarA);
      if (cmp !== 0) return cmp;
      return stableKey(a).localeCompare(stableKey(b));
    }
    if (dollarA !== null) return -1;
    if (dollarB !== null) return 1;
    const cmp = percentValue(b).comparedTo(percentValue(a));
    if (cmp !== 0) return cmp;
    return stableKey(a).localeCompare(stableKey(b));
  });
};
