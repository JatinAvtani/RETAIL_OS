/**
 * Money arithmetic for the corpus — integer-scaled BigInt at 4 decimal places, never JS floats.
 *
 * These are lifted VERBATIM from the existing `seed-demo-invoices.mts`, deliberately unchanged.
 * The document pipeline runs an arithmetic validation gate over every extracted invoice: each line
 * total must equal qty x unitPrice, and the invoice total must equal the sum of its lines, to the
 * cent. A float-based helper here would produce values that fail that gate on some rows and pass on
 * others — the exact intermittent, data-dependent failure this project's I5 invariant exists to
 * prevent. `0.1 + 0.2 !== 0.3` is a wrong invoice, not a rounding curiosity.
 */

/** qty (integer string) x unitPrice (4dp string) -> 4dp string. */
export const mulPackPrice = (qty: string, unitPrice: string): string => {
  const [intPart = '0', fracPart = ''] = unitPrice.split('.');
  const scaled = BigInt(intPart + fracPart.padEnd(4, '0').slice(0, 4)) * BigInt(qty);
  const s = scaled.toString().padStart(5, '0');
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
};

/** Sums 4dp strings -> 4dp string. */
export const sumMoney = (values: string[]): string => {
  const total = values.reduce((sum, v) => {
    const [i = '0', f = ''] = v.split('.');
    return sum + BigInt(i + f.padEnd(4, '0').slice(0, 4));
  }, 0n);
  const s = total.toString().padStart(5, '0');
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
};

/** Multiplies a 4dp money string by a percentage expressed in basis points (e.g. 250 = 2.5%), truncating toward zero. Used for GST splits, where the statutory figure is derived, never floated. */
export const mulBasisPoints = (value4dp: string, basisPoints: number): string => {
  const [i = '0', f = ''] = value4dp.split('.');
  const scaled = BigInt(i + f.padEnd(4, '0').slice(0, 4)) * BigInt(basisPoints);
  const divided = scaled / 10000n;
  const s = divided.toString().padStart(5, '0');
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
};

/** Applies a percentage change to a 4dp price, e.g. `+12.5%` for the planted price-creep finding. Basis points keep the step itself exact and reproducible. */
export const applyPercent = (value4dp: string, basisPoints: number): string =>
  sumMoney([value4dp, mulBasisPoints(value4dp, basisPoints)]);

/** 4dp -> 2dp for display on a printed invoice. Truncates; never rounds up a price the buyer didn't agree to. */
export const toDisplay2dp = (value4dp: string): string => value4dp.slice(0, -2);

/** Formats a plain number of rupees as a 4dp money string. For authoring readable source figures ("450") without hand-writing trailing zeros. */
export const rupees = (whole: number, paise = 0): string =>
  `${whole}.${String(paise).padStart(2, '0').slice(0, 2).padEnd(4, '0')}`;
