import { describe, expect, it } from 'vitest';
import { formatMoney, formatMoneyTotal } from './format';

/**
 * Digit grouping is presentational, but getting it wrong is not cosmetic: an Indian operator reading
 * `2,304,715` has to stop and count digits to know whether that is twenty-three lakh or two million.
 * These cases pin the convention so a refactor cannot quietly revert it — and pin that USD is
 * unaffected, since a single shared formatter serving both is exactly where that regression hides.
 */
describe('formatMoney — grouping follows the currency', () => {
  it('groups INR the Indian way: last three digits, then pairs', () => {
    expect(formatMoneyTotal('2304285.00', 'INR')).toBe('INR 23,04,285.00');
    expect(formatMoneyTotal('100000.00', 'INR')).toBe('INR 1,00,000.00');
    expect(formatMoneyTotal('10000000.00', 'INR')).toBe('INR 1,00,00,000.00');
  });

  it('keeps Western thousands grouping for every other currency', () => {
    expect(formatMoneyTotal('2304715.00', 'USD')).toBe('USD 2,304,715.00');
    expect(formatMoneyTotal('1234567.891', 'USD')).toBe('USD 1,234,567.89');
    expect(formatMoneyTotal('2304715.00', 'GBP')).toBe('GBP 2,304,715.00');
    expect(formatMoneyTotal('2304715.00', 'EUR')).toBe('EUR 2,304,715.00');
  });

  it('falls back to Western grouping when no currency is given', () => {
    // A bare number has no currency context, so the safe default is the pre-existing behaviour
    // rather than assuming INR — the caller that knows the currency should pass it.
    expect(formatMoneyTotal('2304715.00')).toBe('2,304,715.00');
  });

  it('leaves amounts below one thousand ungrouped', () => {
    expect(formatMoneyTotal('999.00', 'INR')).toBe('INR 999.00');
    expect(formatMoneyTotal('1000.00', 'INR')).toBe('INR 1,000.00');
  });

  it('keeps the minus sign outside the grouping', () => {
    expect(formatMoneyTotal('-162469.7036', 'INR')).toBe('INR -1,62,469.70');
  });
});

describe('formatMoney — precision', () => {
  it('rounds a TOTAL to exactly two places, half-up', () => {
    expect(formatMoneyTotal('162469.7036', 'INR')).toBe('INR 1,62,469.70');
    expect(formatMoneyTotal('4757324.277', 'INR')).toBe('INR 47,57,324.28');
  });

  it('carries correctly when rounding crosses a digit boundary', () => {
    // Done on the string with BigInt, never a float: these amounts exceed Number.MAX_SAFE_INTEGER
    // in minor units, so `Number(x).toFixed(2)` would lose precision before it ever rounded.
    expect(formatMoneyTotal('0.995', 'INR')).toBe('INR 1.00');
    expect(formatMoneyTotal('9.999', 'INR')).toBe('INR 10.00');
  });

  it('preserves sub-paisa precision for a UNIT COST rather than rounding it away', () => {
    // Unit costs are genuinely stored at 4dp (INR 0.0568/g of atta). Rounding here would display a
    // different number from the one the ledger actually used.
    expect(formatMoney('0.0568', 'INR')).toBe('INR 0.0568');
    expect(formatMoney('0.875', 'INR')).toBe('INR 0.875');
  });

  it('still pads a unit cost to at least two places', () => {
    expect(formatMoney('3.8', 'INR')).toBe('INR 3.80');
  });
});
