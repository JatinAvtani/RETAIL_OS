import { describe, expect, it } from 'vitest';
import { formatVariants } from './format-variants';

/**
 * `formatVariants`'s own contract — every string form a real bundle value could
 * plausibly appear as in a narration response. settled deliberately: before writing:
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

  /**
   * These pin the ALLOWLIST, not a formatter. Without an Indian-grouped variant the validator would
   * reject a correctly-written rupee figure as ungrounded, so the model falls back to the raw bundle
   * value and the briefing reads "your dead stock value is 407619.3100".
   */
  it('allows Indian (lakh/crore) grouping so a rupee figure can be written readably', () => {
    const variants = formatVariants('407619.3100', 'CURRENCY');
    expect(variants).toContain('4,07,619.31');
    expect(variants).toContain('407619.3100');
  });

  it('allows BOTH grouping conventions — the bundle carries no currency code to choose between them', () => {
    const variants = formatVariants('2304715.00', 'CURRENCY');
    expect(variants).toContain('23,04,715.00');
    expect(variants).toContain('2,304,715.00');
  });

  it('groups at crore scale', () => {
    expect(formatVariants('10000000.00', 'CURRENCY')).toContain('1,00,00,000.00');
  });

  it('leaves values below one thousand ungrouped in both conventions', () => {
    const variants = formatVariants('999.00', 'CURRENCY');
    expect(variants).toContain('999.00');
    expect(variants.some((v) => v.includes(',') && v.startsWith('999'))).toBe(false);
  });

  it('keeps the minus sign outside Indian grouping', () => {
    expect(formatVariants('-2304715.00', 'CURRENCY')).toContain('-23,04,715.00');
  });
});
