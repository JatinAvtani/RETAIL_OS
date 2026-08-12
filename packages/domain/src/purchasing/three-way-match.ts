import { Decimal } from 'decimal.js';

/**
 * 008-10 (plan.md Phase 4, spec 05 §5.2.4): "the financial control that catches real money."
 * A pure function (I1 — no I/O, no business number computed anywhere but here) classifying ONE
 * invoice line's variance against what was ordered (PO) and what arrived (receipt). The caller
 * (008-10's repository) is responsible for finding the candidate PO/receipt line — this function
 * only classifies, given already-resolved inputs, matching `validateExtraction`'s own separation
 * of "find the comparison data" (repository) from "decide what it means" (domain).
 *
 * Tolerances default to plan.md's own literal example ("e.g. ≤2% or ≤$5 auto-accept") — a real,
 * cited default, not an arbitrary number invented for this task. 008-11 (configurable match
 * tolerances) is the real place a per-org override gets built; this function already accepts a
 * `tolerances` parameter so that task only needs to plumb a config value through, not touch this
 * classification logic.
 */

export interface MatchTolerances {
  /** Fractional tolerance on unit price, e.g. 0.02 for 2%. */
  priceTolerancePercent: Decimal;
  /** Absolute dollar tolerance on the line's total price variance. */
  priceToleranceAbsolute: Decimal;
  /** Fractional tolerance on quantity, e.g. 0.02 for 2%. */
  quantityTolerancePercent: Decimal;
}

export const DEFAULT_MATCH_TOLERANCES: MatchTolerances = {
  priceTolerancePercent: new Decimal('0.02'),
  priceToleranceAbsolute: new Decimal('5'),
  quantityTolerancePercent: new Decimal('0.02'),
};

export type VarianceType = 'CLEAN' | 'PRICE_VARIANCE' | 'QUANTITY_VARIANCE' | 'UNORDERED_ITEM' | 'INVOICED_NOT_RECEIVED';
export type VarianceSeverity = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface InvoiceLineForMatch {
  quantity: Decimal | null;
  unitPrice: Decimal | null;
}

/** What the PO/receipt resolution found for this invoice line — all `null` means no PO line and no receipt line matched at all (an unordered item, or an item invoiced but genuinely never received). */
export interface MatchCandidate {
  poUnitPrice: Decimal | null;
  receivedQuantity: Decimal | null;
  /** True when a receipt line was found at all (even with a 0 received quantity) — distinguishes "matched a receipt showing nothing arrived" from "no receipt exists," since only the latter is the high-priority INVOICED_NOT_RECEIVED case. */
  receiptFound: boolean;
}

export interface LineMatchResult {
  varianceType: VarianceType;
  varianceSeverity: VarianceSeverity;
  priceVariance: Decimal | null;
  quantityVariance: Decimal | null;
  explanation: string;
}

/**
 * Classifies one invoice line per plan.md's variance table. Order of checks matters: an unordered
 * item (no PO/receipt match resolved at all) is checked before price/quantity comparisons, since
 * there is nothing to compare against. `INVOICED_NOT_RECEIVED` — plan.md's own "possible
 * fraud/error" framing — fires when a PO line was matched (so the item genuinely was ordered) but
 * no receipt exists for it; `UNORDERED_ITEM` is the case with no PO match either.
 *
 * Unparseable invoice values (I7: never coerced to 0 or skipped silently) produce their own
 * distinct outcome — a variance the system genuinely cannot classify is not the same fact as "no
 * variance," so this never falls through to CLEAN.
 */
export const classifyLineMatch = (
  invoiceLine: InvoiceLineForMatch,
  candidate: MatchCandidate,
  tolerances: MatchTolerances = DEFAULT_MATCH_TOLERANCES
): LineMatchResult => {
  const { quantity: invoiceQty, unitPrice: invoiceUnitPrice } = invoiceLine;

  if (invoiceQty === null || invoiceUnitPrice === null) {
    return {
      varianceType: 'UNORDERED_ITEM',
      varianceSeverity: 'MEDIUM',
      priceVariance: null,
      quantityVariance: null,
      explanation: 'This invoice line could not be read reliably (quantity or unit price missing) — review manually.',
    };
  }

  const hasPoMatch = candidate.poUnitPrice !== null;
  if (!hasPoMatch && !candidate.receiptFound) {
    return {
      varianceType: 'UNORDERED_ITEM',
      varianceSeverity: 'MEDIUM',
      priceVariance: null,
      quantityVariance: null,
      explanation: 'No purchase order or receipt line matches this invoice item — it was billed but never ordered or received against.',
    };
  }

  if (hasPoMatch && !candidate.receiptFound) {
    return {
      varianceType: 'INVOICED_NOT_RECEIVED',
      varianceSeverity: 'HIGH',
      priceVariance: null,
      quantityVariance: null,
      explanation: 'This item was ordered and invoiced, but no goods receipt exists for it — possible billing error or fraud. Flagged high priority.',
    };
  }

  let priceVariance: Decimal | null = null;
  let quantityVariance: Decimal | null = null;
  let hasPriceIssue = false;
  let hasQuantityIssue = false;
  const messages: string[] = [];

  if (candidate.poUnitPrice !== null) {
    priceVariance = invoiceUnitPrice.minus(candidate.poUnitPrice);
    const absVariance = priceVariance.abs();
    const percentOfPo = candidate.poUnitPrice.isZero() ? null : absVariance.dividedBy(candidate.poUnitPrice);
    const withinTolerance =
      absVariance.lessThanOrEqualTo(tolerances.priceToleranceAbsolute) ||
      (percentOfPo !== null && percentOfPo.lessThanOrEqualTo(tolerances.priceTolerancePercent));
    if (!withinTolerance) {
      hasPriceIssue = true;
      messages.push(
        `Invoiced unit price ${invoiceUnitPrice.toFixed(4)} differs from the PO price ${candidate.poUnitPrice.toFixed(4)} by ${priceVariance.toFixed(4)}.`
      );
    }
  }

  if (candidate.receivedQuantity !== null) {
    quantityVariance = invoiceQty.minus(candidate.receivedQuantity);
    const absVariance = quantityVariance.abs();
    const percentOfReceived = candidate.receivedQuantity.isZero() ? null : absVariance.dividedBy(candidate.receivedQuantity);
    const withinTolerance = percentOfReceived !== null && percentOfReceived.lessThanOrEqualTo(tolerances.quantityTolerancePercent);
    const bothZero = absVariance.isZero();
    if (!bothZero && !withinTolerance) {
      hasQuantityIssue = true;
      messages.push(
        `Invoiced quantity ${invoiceQty.toString()} differs from received quantity ${candidate.receivedQuantity.toString()} by ${quantityVariance.toString()}.`
      );
    }
  }

  if (!hasPriceIssue && !hasQuantityIssue) {
    return {
      varianceType: 'CLEAN',
      varianceSeverity: 'NONE',
      priceVariance,
      quantityVariance,
      explanation: 'Invoice line matches the purchase order and receipt within tolerance.',
    };
  }

  // Price variance takes precedence in `varianceType` when both fire — it's typically the more
  // actionable finding for a credit claim — but the explanation always lists every real issue
  // found, never silently dropping the quantity variance's own message.
  const varianceType: VarianceType = hasPriceIssue ? 'PRICE_VARIANCE' : 'QUANTITY_VARIANCE';

  return {
    varianceType,
    varianceSeverity: 'MEDIUM',
    priceVariance,
    quantityVariance,
    explanation: messages.join(' '),
  };
};

/** The overall severity for an `InvoiceMatch` is the highest severity among its lines — a manager reviewing the queue needs to know the worst thing on this invoice, not an average. */
export const highestSeverity = (severities: VarianceSeverity[]): VarianceSeverity => {
  const order: VarianceSeverity[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH'];
  return severities.reduce<VarianceSeverity>((worst, current) => (order.indexOf(current) > order.indexOf(worst) ? current : worst), 'NONE');
};
