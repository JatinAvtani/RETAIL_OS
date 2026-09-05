import { Decimal } from 'decimal.js';
import type { VarianceType, VarianceSeverity, LineForDollarImpact } from './three-way-match';
import { computeLineDollarImpact } from './three-way-match';

/**
 * the Razorpay AI Buildathon "AI Finance Controller" track brief asks for an agent that
 * "closes one finance-ops loop across a 50+ record batch of synthetic data, reporting its match
 * rate and the exceptions it could not resolve" — a real, measured throughput/accuracy report, not
 * a single cherry-picked example. This module is the pure aggregation layer over ALREADY-CLASSIFIED
 * invoice-match lines (`classifyLineMatch`, `three-way-match.ts` — I2: never re-classifies, never
 * re-derives a dollar figure, only rolls up what was already decided). No I/O, no model call
 * anywhere in this file (I1) — a batch's match rate and exception ranking are pure arithmetic over
 * real, already-persisted classification results.
 */

export type ReconciledLine = LineForDollarImpact & {
  /** Identifies the line for the exception list — real product/invoice identifiers, not an opaque index. */
  lineId: string;
  invoiceMatchId: string;
  supplierName: string;
  productName: string | null;
  varianceSeverity: VarianceSeverity;
  explanation: string;
};

export type BatchExceptionLine = {
  lineId: string;
  invoiceMatchId: string;
  supplierName: string;
  productName: string | null;
  varianceType: VarianceType;
  varianceSeverity: VarianceSeverity;
  /** Signed, matching `computeLineDollarImpact`'s own contract — `null` only when the line's own
   * inputs were themselves unparseable, never a fabricated 0 standing in for unknown exposure. */
  dollarImpact: Decimal | null;
  explanation: string;
};

export type ReconciliationBatchReport = {
  /** Total lines the batch actually classified — the real denominator, never assumed to equal the
   * caller's requested batch size (a batch that yields fewer real lines than requested is an honest
   * fact to report, not silently padded). */
  totalLines: number;
  cleanLines: number;
  /** `cleanLines / totalLines`, expressed 0-1 — `null` (never a fabricated 0% or 100%) when
   * `totalLines` is 0, matching this codebase's I7 discipline for a ratio with no real denominator. */
  matchRate: Decimal | null;
  /** Every non-CLEAN line, ranked by `|dollarImpact|` descending (unresolvable-impact lines — a
   * `null` dollarImpact — sort last, never treated as zero and hidden at the bottom silently; they
   * are still real, listed exceptions, just not orderable by a number that doesn't exist). This is
   * the report's "exceptions it could not resolve" — every one traceable to a real invoice line. */
  exceptions: BatchExceptionLine[];
  /** Sum of every REAL (non-null) exception dollarImpact — signed. `null` only when EVERY exception
   * line's own impact is unknown (never a fabricated total from partial data). */
  totalExceptionImpact: Decimal | null;
  /** Count of exception lines whose dollar impact could not be computed at all — a distinct, honest
   * fact from "resolved clean" or "resolved with a known dollar impact." The brief's own "exceptions
   * it could not resolve" applies doubly here: not matched AND not even priceable. */
  unresolvableCount: number;
};

/**
 * Rolls up a real batch of already-classified reconciliation lines into the measured report the
 * track brief asks for. Deliberately takes `ReconciledLine[]` (a flat list spanning however many
 * real invoice matches the caller gathered) rather than a single invoice's lines — "50+ record
 * batch" is explicitly a cross-invoice measure, not a single document's own match rate.
 */
export const buildReconciliationBatchReport = (lines: ReconciledLine[]): ReconciliationBatchReport => {
  const totalLines = lines.length;
  const cleanLines = lines.filter((l) => l.varianceType === 'CLEAN').length;
  const matchRate = totalLines === 0 ? null : new Decimal(cleanLines).dividedBy(totalLines);

  const exceptionSource = lines.filter((l) => l.varianceType !== 'CLEAN');
  const unresolvableCount = exceptionSource.filter((l) => computeLineDollarImpact(l) === null).length;

  const exceptions: BatchExceptionLine[] = exceptionSource
    .map((l) => ({
      lineId: l.lineId,
      invoiceMatchId: l.invoiceMatchId,
      supplierName: l.supplierName,
      productName: l.productName,
      varianceType: l.varianceType,
      varianceSeverity: l.varianceSeverity,
      dollarImpact: computeLineDollarImpact(l),
      explanation: l.explanation,
    }))
    .sort((a, b) => {
      if (a.dollarImpact === null && b.dollarImpact === null) return 0;
      if (a.dollarImpact === null) return 1; // unresolvable-impact lines sort last, never first
      if (b.dollarImpact === null) return -1;
      return b.dollarImpact.abs().comparedTo(a.dollarImpact.abs());
    });

  const knownImpacts = exceptions.map((e) => e.dollarImpact).filter((d): d is Decimal => d !== null);
  const totalExceptionImpact = knownImpacts.length === 0 ? (exceptions.length === 0 ? new Decimal(0) : null) : knownImpacts.reduce((sum, d) => sum.plus(d), new Decimal(0));

  return { totalLines, cleanLines, matchRate, exceptions, totalExceptionImpact, unresolvableCount };
};
