import { Decimal } from 'decimal.js';
import type { Unit } from '../primitives/unit.js';
import type { Quantity } from '../primitives/quantity.js';
import { quantity, scaleQuantity, addQuantity, subtractQuantity, compareQuantity, zeroQuantity } from '../primitives/quantity.js';
import type { Money } from '../primitives/money.js';
import { compareMoney, scaleMoney } from '../primitives/money.js';

/**
 * One day's real consumption, or `null` if the store was closed that day. Closures are excluded
 * from the trimmed mean entirely (not counted as zero-consumption days), matching the plan — a
 * zero from a closure would drag the average down and understate real daily usage.
 */
export type ConsumptionDay = {
  date: Date;
  quantityConsumed: Quantity<Unit> | null;
  isClosureDay: boolean;
};

export type ReorderInput = {
  stockOnHand: Quantity<Unit>;
  onOrder: Quantity<Unit>;
  consumptionHistory: readonly ConsumptionDay[];
  supplier: {
    measuredLeadTimeDays: number | null;
    contractedLeadTimeDays: number | null;
    minOrderValue: Money | null;
  };
  supplierProduct: {
    packSize: Quantity<Unit> | null;
  };
  unitPrice: Money | null;
  coverageDays: Decimal | number;
};

export type ReorderConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type ReorderExplanation = {
  dailyConsumption: Quantity<Unit>;
  currentCoverDays: Decimal | null;
  leadTimeDays: number;
  coverageDays: Decimal;
  packSize: Quantity<Unit> | null;
};

export type ReorderSuggestion = {
  quantity: Quantity<Unit>;
  confidence: ReorderConfidence;
  explanation: ReorderExplanation;
};

const TRIM_PERCENT = 10;

/**
 * Mean of `values` after discarding the top and bottom `trimPercent`% (rounded down) from each
 * tail — dulls the effect of one-off catering orders or holiday spikes without discarding them
 * outright. Returns `null` for an empty input rather than a fabricated zero (I7): "no data" and
 * "measured zero consumption" are different facts and must not collapse into the same number.
 */
const trimmedMean = (values: readonly Decimal[]): Decimal | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const trimCount = Math.floor((sorted.length * TRIM_PERCENT) / 100);
  const kept = trimCount > 0 && sorted.length - 2 * trimCount > 0 ? sorted.slice(trimCount, sorted.length - trimCount) : sorted;
  const sum = kept.reduce((acc, v) => acc.plus(v), new Decimal(0));
  return sum.div(kept.length);
};

/**
 * Population standard deviation of `values` around `mean` — the input to safety-stock scaling.
 * `values.length < 2` has no meaningful variability signal, so returns `null` (I7) rather than 0,
 * which would silently claim "perfectly steady demand" for a single data point.
 */
const standardDeviation = (values: readonly Decimal[], mean: Decimal): Decimal | null => {
  if (values.length < 2) return null;
  const sumSquaredDiff = values.reduce((acc, v) => acc.plus(v.minus(mean).pow(2)), new Decimal(0));
  return sumSquaredDiff.div(values.length).sqrt();
};

/**
 * Safety-stock coverage (in days) scales with how erratic consumption has been — a supplier
 * with wildly variable daily draw needs a bigger buffer than one with steady, predictable
 * demand, even at the same average. Expressed via the coefficient of variation (stdDev/mean),
 * scaled onto a `[baseDays, baseDays * 2]` range and capped there so one extreme outlier day
 * can't demand an unbounded safety stock. Monotonic in the coefficient of variation by
 * construction (property-tested) — never decreasing as variability increases.
 */
const scaleWithVariability = (dailyValues: readonly Decimal[], mean: Decimal, baseDays: Decimal): Decimal => {
  if (mean.lessThanOrEqualTo(0)) return baseDays;
  const stdDev = standardDeviation(dailyValues, mean);
  if (stdDev === null) return baseDays;

  const coefficientOfVariation = stdDev.div(mean);
  // Full scale-up (2x baseDays) reached once CoV hits 1.0 (stdDev == mean); clamped above that.
  const scaleFactor = Decimal.min(1, coefficientOfVariation);
  return baseDays.plus(baseDays.times(scaleFactor));
};

/**
 * Rounds `needed` up to the next whole multiple of `packSize` — a supplier sells cases/packs,
 * not arbitrary fractions, so any non-multiple suggestion is literally unorderable. `packSize:
 * null` (no pack-size data yet) passes `needed` through unchanged rather than guessing a size.
 */
export const roundUpToPackSize = <U extends Unit>(needed: Quantity<U>, packSize: Quantity<U> | null): Quantity<U> => {
  if (packSize === null || packSize.amount.lessThanOrEqualTo(0)) return needed;
  if (needed.amount.lessThanOrEqualTo(0)) return zeroQuantity(needed.unit);

  const packs = needed.amount.div(packSize.amount).ceil();
  return scaleQuantity(packSize, packs);
};

/**
 * Raises `qty` (never lowers it — the plan's own property: MOQ enforcement never reduces below
 * the computed need) so the order's total value clears the supplier's minimum. Requires a real
 * `unitPrice` to compute order value; with no price or no MOQ configured, `qty` passes through
 * unchanged — an unpriced line can't be judged against a dollar minimum, and fabricating one
 * would be exactly the I7 violation this project forbids.
 */
export const enforceMoq = <U extends Unit>(
  qty: Quantity<U>,
  minOrderValue: Money | null,
  unitPrice: Money | null,
  packSize: Quantity<U> | null
): Quantity<U> => {
  if (minOrderValue === null || unitPrice === null) return qty;

  const orderValue = scaleMoney(unitPrice, qty.amount);
  if (compareMoney(orderValue, minOrderValue) >= 0) return qty;

  // Raise quantity until order value clears the minimum, then re-round to pack size so the MOQ
  // bump itself never produces an unorderable fractional-pack quantity.
  const neededForMoq = minOrderValue.amount.div(unitPrice.amount);
  const raised = quantity(Decimal.max(qty.amount, neededForMoq), qty.unit);
  return roundUpToPackSize(raised, packSize);
};

const confidenceFrom = (consumptionHistory: readonly ConsumptionDay[]): ReorderConfidence => {
  const measuredDays = consumptionHistory.filter((d) => !d.isClosureDay && d.quantityConsumed !== null).length;
  if (measuredDays >= 14) return 'HIGH';
  if (measuredDays >= 5) return 'MEDIUM';
  return 'LOW';
};

/**
 * Deterministic reorder suggestion — no ML, per ADR-07: a new tenant has no history for a model
 * to learn from, and an explainable suggestion a manager can verify gets overridden intelligently
 * when wrong, while a black-box one gets ignored entirely regardless of its real accuracy.
 *
 * Returns `null` (never a guessed quantity) when there is no usable consumption history at all —
 * this is the honest "par-level only, flagged low-confidence" case the plan and I7 both require;
 * the caller is responsible for falling back to a par-level-based suggestion, which needs no
 * consumption history and is therefore out of this function's scope.
 */
export const suggestReorder = (input: ReorderInput): ReorderSuggestion | null => {
  const measuredDays = input.consumptionHistory.filter((d) => !d.isClosureDay && d.quantityConsumed !== null);
  if (measuredDays.length === 0) return null;

  const unit = input.stockOnHand.unit;
  const dailyAmounts = measuredDays.map((d) => d.quantityConsumed!.amount);
  const meanAmount = trimmedMean(dailyAmounts);
  if (meanAmount === null || meanAmount.lessThanOrEqualTo(0)) return null;

  const dailyConsumption = quantity(meanAmount, unit);

  const leadTimeDays = input.supplier.measuredLeadTimeDays ?? input.supplier.contractedLeadTimeDays;
  if (leadTimeDays === null) return null;

  const baseSafetyDays = new Decimal(leadTimeDays).times(0.5);
  const safetyDays = scaleWithVariability(dailyAmounts, meanAmount, baseSafetyDays);
  const safetyStock = scaleQuantity(dailyConsumption, safetyDays);
  const leadTimeConsumption = scaleQuantity(dailyConsumption, leadTimeDays);
  const reorderPoint = addQuantity(leadTimeConsumption, safetyStock);

  const projected = subtractQuantity(addQuantity(input.stockOnHand, input.onOrder), leadTimeConsumption);
  if (compareQuantity(projected, reorderPoint) >= 0) return null;

  const coverageDays = input.coverageDays instanceof Decimal ? input.coverageDays : new Decimal(input.coverageDays);
  const target = addQuantity(scaleQuantity(dailyConsumption, coverageDays), safetyStock);
  const rawNeeded = subtractQuantity(subtractQuantity(target, input.stockOnHand), input.onOrder);
  const needed = rawNeeded.amount.lessThanOrEqualTo(0) ? zeroQuantity(unit) : rawNeeded;

  const packRounded = roundUpToPackSize(needed, input.supplierProduct.packSize);
  const finalQty = enforceMoq(packRounded, input.supplier.minOrderValue, input.unitPrice, input.supplierProduct.packSize);

  if (finalQty.amount.lessThanOrEqualTo(0)) return null;

  return {
    quantity: finalQty,
    confidence: confidenceFrom(input.consumptionHistory),
    explanation: {
      dailyConsumption,
      currentCoverDays: input.stockOnHand.amount.greaterThan(0) ? input.stockOnHand.amount.div(meanAmount) : null,
      leadTimeDays,
      coverageDays,
      packSize: input.supplierProduct.packSize,
    },
  };
};
