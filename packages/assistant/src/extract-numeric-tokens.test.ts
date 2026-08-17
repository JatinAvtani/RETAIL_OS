import { describe, expect, it } from 'vitest';
import { extractNumericTokens } from './extract-numeric-tokens';

/**
 * 010-11: covers plan.md's own exact test list verbatim — "currency symbols · thousands
 * separators · percentages · ranges · dates excluded · ordinals excluded · abbreviated forms ·
 * numbers inside quoted source text · numbers the model derived by arithmetic (must be caught)."
 *
 * Confirmed via `AskUserQuestion`: ambiguous cases are biased toward FLAGGING, not excluding — a
 * bare number that merely resembles a year/date with no real surrounding date context is NOT
 * excluded, since an undetected fabricated number is the one outcome this product cannot survive.
 */
describe('extractNumericTokens', () => {
  it('extracts a plain decimal number', () => {
    expect(extractNumericTokens('Your net revenue was 1234.56.')).toEqual(['1234.56']);
  });

  it('extracts a thousands-separated number, keeping the commas in the raw token', () => {
    expect(extractNumericTokens('Your net revenue was $1,234.56.')).toEqual(['1,234.56']);
  });

  it('extracts a percentage with its % sign', () => {
    expect(extractNumericTokens('Food cost was 28.4% this period.')).toEqual(['28.4%']);
  });

  it('extracts both numbers in a range, as two separate tokens', () => {
    expect(extractNumericTokens('Revenue was between 20 and 30 thousand.')).toEqual(['20', '30']);
  });

  it('excludes a real calendar date — "August 2026"', () => {
    expect(extractNumericTokens('As of August 2026, your revenue was 500.')).toEqual(['500']);
  });

  it('excludes a real ISO date — "2026-08-01"', () => {
    expect(extractNumericTokens('As of 2026-08-01, your revenue was 500.')).toEqual(['500']);
  });

  it('excludes a real ordinal — "1st"', () => {
    expect(extractNumericTokens('On the 1st, revenue was 500.')).toEqual(['500']);
  });

  it('excludes list numbering at the start of a line', () => {
    expect(extractNumericTokens('1. Revenue: 100\n2. Cost: 50')).toEqual(['100', '50']);
  });

  it('excludes an abbreviated form like "1.2k" only in the sense that it is extracted intact, not split — "k" itself is not a numeric token', () => {
    expect(extractNumericTokens('Revenue was 1.2k this week.')).toEqual(['1.2']);
  });

  it('excludes a number inside a quoted span — it is cited source text, not a claim', () => {
    expect(extractNumericTokens('The invoice said "total: 999" but the real figure is 500.')).toEqual(['500']);
  });

  it('a number the model derived by arithmetic (e.g. an average it computed itself) is caught, not excluded', () => {
    // The extractor has no way to know 750 was derived by arithmetic vs. a real bundle value —
    // that judgment is validateGrounding's job (checking it against the real allowlist), not
    // extractNumericTokens's. This test proves the number is NOT silently dropped here.
    expect(extractNumericTokens('The average of 500 and 1000 is 750.')).toEqual(['500', '1000', '750']);
  });

  it('a bare number resembling a year, with NO real date context, is NOT excluded — biased toward flagging', () => {
    expect(extractNumericTokens('That is a 2026 kind of number.')).toEqual(['2026']);
  });

  it('prose with no numbers at all produces an empty array', () => {
    expect(extractNumericTokens('We made about a third more this year.')).toEqual([]);
  });

  it('a real, complete narration sentence with a mix of grounded figure and excluded date', () => {
    const response = 'For the period from August 1, 2026, to August 31, 2026, your net revenue was 4582.75.';
    expect(extractNumericTokens(response)).toEqual(['4582.75']);
  });
});
