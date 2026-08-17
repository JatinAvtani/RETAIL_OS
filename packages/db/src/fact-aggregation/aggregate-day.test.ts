import { describe, expect, it } from 'vitest';
import { resolveYesterdayLocalDate } from './aggregate-day.js';

describe('resolveYesterdayLocalDate', () => {
  it('resolves the real previous calendar date in the given timezone', () => {
    const now = new Date('2026-06-15T12:00:00Z'); // midday UTC, well inside June 15 for any real zone
    expect(resolveYesterdayLocalDate('UTC', now)).toBe('2026-06-14');
    expect(resolveYesterdayLocalDate('America/New_York', now)).toBe('2026-06-14');
  });

  it('correctly crosses a month boundary', () => {
    const now = new Date('2026-07-01T12:00:00Z');
    expect(resolveYesterdayLocalDate('UTC', now)).toBe('2026-06-30');
  });

  it('correctly crosses a year boundary', () => {
    const now = new Date('2027-01-01T12:00:00Z');
    expect(resolveYesterdayLocalDate('UTC', now)).toBe('2026-12-31');
  });

  it('a timezone far enough behind UTC can genuinely be on the PREVIOUS UTC calendar day already — "yesterday" still resolves correctly relative to the store\'s OWN today', () => {
    // 2026-06-15 02:00 UTC is 2026-06-14 18:00 in Honolulu (UTC-10, no DST) — Honolulu's "today" is
    // still June 14, so Honolulu's "yesterday" is June 13.
    const now = new Date('2026-06-15T02:00:00Z');
    expect(resolveYesterdayLocalDate('Pacific/Honolulu', now)).toBe('2026-06-13');
  });
});
