import { describe, expect, it } from 'vitest';
import { formatVariants } from './format-variants';

/**
 * 010-11: `formatVariants`'s own contract — every string form a real bundle value could
 * plausibly appear as in a narration response. Confirmed via `AskUserQuestion` before writing:
 * no currency-symbol variants ($/€/£) — `MetricResult` carries no currency code, so pre-allowing
 * a symbol would widen "grounded" beyond what this codebase actually knows.
 */
describe('formatVariants', () => {
  it('always includes the exact stored value', () => {
    expect(formatVariants('1234.5600', 'CURRENCY')).toContain('1234.5600');
  });

  it('includes a thousands-separated form', () => {
    const variants = formatVariants('1234.56', 'CURRENCY');
    expect(variants).toContain('1,234.56');
  });

  it('includes common decimal-precision variants', () => {
    const variants = formatVariants('1234.5600', 'CURRENCY');
    expect(variants).toContain('1235'); // toFixed(0), rounded
    expect(variants).toContain('1234.6'); // toFixed(1), rounded
    expect(variants).toContain('1234.56'); // toFixed(2)
  });

  it('includes an abbreviated "k" form for thousands', () => {
    const variants = formatVariants('1234.56', 'CURRENCY');
    expect(variants).toContain('1.2k');
  });

  it('includes an abbreviated "m" form for millions', () => {
    const variants = formatVariants('2500000', 'CURRENCY');
    expect(variants).toContain('2.5m');
  });

  it('never generates a currency symbol variant — MetricResult carries no currency code to invent one from', () => {
    const variants = formatVariants('1234.56', 'CURRENCY');
    expect(variants.some((v) => /[$€£¥]/.test(v))).toBe(false);
  });

  it('adds a % suffix to every variant for PERCENTAGE-unit values, never for other units', () => {
    const pctVariants = formatVariants('28.4', 'PERCENTAGE');
    expect(pctVariants).toContain('28.4%');

    const countVariants = formatVariants('28.4', 'COUNT');
    expect(countVariants.some((v) => v.endsWith('%'))).toBe(false);
  });

  it('handles a real zero value without producing NaN or an empty variant', () => {
    const variants = formatVariants('0.0000', 'CURRENCY');
    expect(variants).toContain('0.0000');
    expect(variants).toContain('0');
    expect(variants.every((v) => v.length > 0 && !v.includes('NaN'))).toBe(true);
  });

  it('handles a real negative value (e.g. cost_variance can be negative) without crashing', () => {
    const variants = formatVariants('-150.25', 'CURRENCY');
    expect(variants).toContain('-150.25');
  });
});
