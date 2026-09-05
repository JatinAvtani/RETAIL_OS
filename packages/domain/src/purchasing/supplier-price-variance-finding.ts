import { Decimal } from 'decimal.js';
import { detectPriceChange, DEFAULT_PRICE_CHANGE_THRESHOLD_PERCENT } from './price-change.js';

/**
 * the ongoing-operational-check sibling to
 * `packages/domain/src/onboarding/first-finding-report.ts`'s `buildPriceChangeFinding` — that
 * function reads a persisted `PRICE_CHANGE` supplier-performance event, a real thing that exists
 * only from `PostingService`'s own posting-time detection. This function instead compares real
 * TRAILING supplier price history directly (`SupplierPriceRepository
 * .findConfirmedTrailingPricesBySupplierSku`, this epic's second `ActionCandidate` source alongside
 * reorder suggestions) — the source this epic's proactive/on-demand investigation needs, since it
 * must be able to check "has this supplier's price moved" at any time, not only react to an event
 * that happened to fire during posting.
 *
 * Reuses `detectPriceChange` (I2 — the SAME formula `PostingService` and the onboarding finding
 * both already use), never a third reimplementation. Pure (I1) — no I/O, no model call.
 */

export type SupplierPriceVarianceFinding = {
  kind: 'SUPPLIER_PRICE_VARIANCE';
  supplierName: string;
  productName: string;
  percentChange: string;
  direction: 'up' | 'down';
  /** `'unknown'` (never a fabricated dollar figure, I7) when no trailing quantity is supplied — this
   * function's own caller decides whether trailing 12mo receipt volume is available to price it. */
  annualizedImpact: string | 'unknown';
  occurredAt: Date;
  evidenceDocumentIds: string[];
};

export type TrailingPricePoint = {
  unitPrice: Decimal;
  validFrom: Date;
  currency: string;
  /** The real document a confirmed price traces back to, when one exists — an entry with no source
   * document (a manually-confirmed price with no invoice behind it) still counts, just with no
   * evidence to cite. */
  sourceDocumentId: string | null;
};

/**
 * Compares the two MOST RECENT confirmed prices for one real supplier product — newest against the
 * one immediately before it, matching `findConfirmedTrailingPricesBySupplierSku`'s own
 * newest-first ordering contract. Returns `null` (never a fabricated finding) when:
 * - fewer than 2 confirmed prices exist (nothing to compare against yet — I7),
 * - the two most recent prices are in different currencies (an incomparable pair, never converted
 * here — the exact I6 discipline `buildCrossSupplierPriceFindings` already applies to pack
 * sizes, applied here to currency instead),
 * - the change is within the real significance threshold (`detectPriceChange`'s own gate — a
 * genuinely small fluctuation is not a finding worth surfacing, matching this codebase's
 * existing 2% bar rather than a new, arbitrary one).
 */
export const buildSupplierPriceVarianceFinding = (input: {
  supplierName: string;
  productName: string;
  /** Newest-first, matching `findConfirmedTrailingPricesBySupplierSku`'s real return order. */
  history: readonly TrailingPricePoint[];
  /** Real trailing-12mo receipt quantity for this product, if the caller has it — threaded straight
   * into `detectPriceChange`'s own `trailing12moQuantity`, never re-derived here (I2). */
  trailing12moQuantity?: Decimal | null;
  thresholdPercent?: Decimal;
}): SupplierPriceVarianceFinding | null => {
  if (input.history.length < 2) return null;

  const [latest, previous] = input.history;
  if (latest!.currency.toLowerCase() !== previous!.currency.toLowerCase()) return null;

  const result = detectPriceChange(
    {
      oldUnitPrice: previous!.unitPrice,
      newUnitPrice: latest!.unitPrice,
      trailing12moQuantity: input.trailing12moQuantity ?? null,
    },
    input.thresholdPercent ?? DEFAULT_PRICE_CHANGE_THRESHOLD_PERCENT
  );

  if (!result.isSignificantChange || result.percentChange === null) return null;

  const evidenceDocumentIds = [latest!.sourceDocumentId, previous!.sourceDocumentId].filter((id): id is string => id !== null);

  return {
    kind: 'SUPPLIER_PRICE_VARIANCE',
    supplierName: input.supplierName,
    productName: input.productName,
    percentChange: result.percentChange.times(100).toFixed(1),
    direction: latest!.unitPrice.greaterThan(previous!.unitPrice) ? 'up' : 'down',
    annualizedImpact: result.annualizedImpact === 'unknown' ? 'unknown' : result.annualizedImpact.toFixed(2),
    occurredAt: latest!.validFrom,
    evidenceDocumentIds,
  };
};
