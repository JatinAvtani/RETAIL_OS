import { addMoney, zeroMoney, type Money } from '@retailos/domain';

/**
 * One exploded ingredient's cost, already resolved by the caller: real supplier price looked up,
 * converted (via `resolveQuantity`, packages/domain) into the same unit the price is expressed
 * in, and multiplied — or `'unknown'` when no confirmed supplier price exists for that product
 * (I7: this is not the same as $0, and must never collapse into one). This function does no
 * lookup or conversion itself; it exists ONLY as the single, registered place a recipe's total
 * cost is computed (I2) from lines that are already resolved.
 */
export type RecipeCostLine = {
  productId: string;
  cost: Money | 'unknown';
};

export type RecipeCostResult = {
  lines: RecipeCostLine[];
  /**
   * `'unknown'` if ANY line is unknown — never a partial sum of only the known lines. A recipe
   * missing one ingredient's price is not "90% costed," it is a recipe whose true cost cannot be
   * stated; a partial total that looks like a real number is exactly the plausible-looking wrong
   * number I7 exists to prevent (the design: "a zero cost silently inflates margin, which is
   * the worst possible failure" — the same reasoning applies to any confident-looking guess).
   */
  total: Money | 'unknown';
};

/**
 * The metric catalog's sole function for recipe cost (I2) — the tRPC layer and any future
 * dashboard/AI-assistant caller must go through this, never sum `Money` values themselves.
 */
export const computeRecipeCost = (lines: RecipeCostLine[], currency: Money['currency']): RecipeCostResult => {
  const anyUnknown = lines.some((line) => line.cost === 'unknown');
  if (anyUnknown) {
    return { lines, total: 'unknown' };
  }

  // A recipe with zero components genuinely costs zero — distinct from 'unknown', which means
  // "at least one line has no price," not "there was nothing to price."
  const knownCosts = lines.map((line) => line.cost as Money);
  const total = knownCosts.reduce((sum, cost) => addMoney(sum, cost), zeroMoney(currency));
  return { lines, total };
};
