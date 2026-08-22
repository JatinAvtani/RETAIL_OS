import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { resolveDaypart, resolveLocalDate, resolveLocalDateRange, resolveLocalDaypart, resolveLocalHour, resolveUtcCronForLocalTime } from './store-time.js';

describe('resolveLocalDate', () => {
  it('resolves the correct LOCAL date even when the UTC date differs', () => {
    // 2026-01-01 03:00 UTC is still 2025-12-31 22:00 in New York (UTC-5 in January).
    const instant = new Date('2026-01-01T03:00:00.000Z');
    expect(resolveLocalDate(instant, 'America/New_York')).toBe('2025-12-31');
    expect(resolveLocalDate(instant, 'UTC')).toBe('2026-01-01');
  });

  it('handles a timezone ahead of UTC crossing into the next local day', () => {
    // 2026-06-01 22:00 UTC is 2026-06-02 07:00 in Tokyo (UTC+9).
    const instant = new Date('2026-06-01T22:00:00.000Z');
    expect(resolveLocalDate(instant, 'Asia/Tokyo')).toBe('2026-06-02');
  });
});

describe('resolveLocalHour', () => {
  it('resolves the correct local hour, never the raw UTC hour, for a non-UTC zone', () => {
    // 2026-06-01 12:00 UTC is 08:00 in New York (UTC-4 in June, daylight saving).
    const instant = new Date('2026-06-01T12:00:00.000Z');
    expect(resolveLocalHour(instant, 'America/New_York')).toBe(8);
  });

  it('resolves midnight as hour 0, not 24', () => {
    const instant = new Date('2026-06-01T00:00:00.000Z');
    expect(resolveLocalHour(instant, 'UTC')).toBe(0);
  });

  it('is a real property: every UTC instant resolves to an hour in [0, 23]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_700_000_000_000 }), (ms) => {
        const hour = resolveLocalHour(new Date(ms), 'America/New_York');
        expect(hour).toBeGreaterThanOrEqual(0);
        expect(hour).toBeLessThanOrEqual(23);
      })
    );
  });
});

describe('resolveDaypart', () => {
  it('classifies each standard boundary correctly', () => {
    expect(resolveDaypart(6)).toBe('BREAKFAST');
    expect(resolveDaypart(10)).toBe('BREAKFAST');
    expect(resolveDaypart(11)).toBe('LUNCH');
    expect(resolveDaypart(14)).toBe('LUNCH');
    expect(resolveDaypart(15)).toBe('DINNER');
    expect(resolveDaypart(20)).toBe('DINNER');
    expect(resolveDaypart(21)).toBe('LATE_NIGHT');
    expect(resolveDaypart(23)).toBe('LATE_NIGHT');
  });

  it('LATE_NIGHT wraps past midnight — an early-morning hour is still LATE_NIGHT, not unclassified', () => {
    expect(resolveDaypart(0)).toBe('LATE_NIGHT');
    expect(resolveDaypart(3)).toBe('LATE_NIGHT');
    expect(resolveDaypart(5)).toBe('LATE_NIGHT');
  });

  it('is a real property: every hour in [0,23] maps to exactly one of the four dayparts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 23 }), (hour) => {
        const daypart = resolveDaypart(hour);
        expect(['BREAKFAST', 'LUNCH', 'DINNER', 'LATE_NIGHT']).toContain(daypart);
      })
    );
  });
});

describe('resolveLocalDaypart', () => {
  it('composes hour resolution and classification correctly across a real timezone offset', () => {
    // 2026-06-01 17:00 UTC is 13:00 in New York (UTC-4, daylight saving) -> LUNCH.
    const instant = new Date('2026-06-01T17:00:00.000Z');
    expect(resolveLocalDaypart(instant, 'America/New_York')).toBe('LUNCH');
  });
});

describe('resolveLocalDateRange', () => {
  it('resolves a plain UTC day exactly (from/to both at UTC midnight, 24h apart)', () => {
    const { from, to } = resolveLocalDateRange('2026-06-15', 'UTC');
    expect(from.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-06-16T00:00:00.000Z');
  });

  it('resolves an ordinary (non-DST-boundary) New York day to a real 24h window at the correct UTC offset', () => {
    // June is EDT (UTC-4) — local midnight 2026-06-15 00:00 is 2026-06-15 04:00 UTC.
    const { from, to } = resolveLocalDateRange('2026-06-15', 'America/New_York');
    expect(from.toISOString()).toBe('2026-06-15T04:00:00.000Z');
    expect(to.toISOString()).toBe('2026-06-16T04:00:00.000Z');
    expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('a January (EST, UTC-5) day resolves to a different real offset than a June (EDT) day', () => {
    const { from } = resolveLocalDateRange('2026-01-15', 'America/New_York');
    expect(from.toISOString()).toBe('2026-01-15T05:00:00.000Z');
  });

  it('the US spring-forward transition day (2026-03-08, EST->EDT) is a real 23-hour UTC window, not 24', () => {
    // Hand-verified via a direct Intl.DateTimeFormat offset check before writing this test:
    // local midnight March 8 is still EST (-05:00) -> 2026-03-08T05:00:00Z.
    // local midnight March 9 is already EDT (-04:00) -> 2026-03-09T04:00:00Z.
    // 05:00Z to next-day 04:00Z is 23 hours, the real number of UTC hours that local day spans.
    const { from, to } = resolveLocalDateRange('2026-03-08', 'America/New_York');
    expect(from.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(to.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(to.getTime() - from.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it('the US fall-back transition day (2026-11-01, EDT->EST) is a real 25-hour UTC window, not 24', () => {
    // local midnight Nov 1 is still EDT (-04:00) -> 2026-11-01T04:00:00Z.
    // local midnight Nov 2 is already EST (-05:00) -> 2026-11-02T05:00:00Z.
    // 04:00Z to next-day 05:00Z is 25 hours.
    const { from, to } = resolveLocalDateRange('2026-11-01', 'America/New_York');
    expect(from.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(to.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(to.getTime() - from.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it('a timezone ahead of UTC (Tokyo, no DST) resolves the correct offset in both directions', () => {
    // Tokyo is a fixed UTC+9 year-round — local midnight 2026-06-15 00:00 is 2026-06-14 15:00 UTC.
    const { from, to } = resolveLocalDateRange('2026-06-15', 'Asia/Tokyo');
    expect(from.toISOString()).toBe('2026-06-14T15:00:00.000Z');
    expect(to.toISOString()).toBe('2026-06-15T15:00:00.000Z');
  });

  it('is a real property: `to` is always strictly after `from`, for any real date/timezone pair', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3650 }).map((days) => {
          const d = new Date(Date.UTC(2026, 0, 1) + days * 24 * 60 * 60 * 1000);
          return d.toISOString().slice(0, 10);
        }),
        fc.constantFrom('UTC', 'America/New_York', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Chatham'),
        (dateStr, timezone) => {
          const { from, to } = resolveLocalDateRange(dateStr, timezone);
          expect(to.getTime()).toBeGreaterThan(from.getTime());
          // Every real IANA zone's calendar day is within a bounded range of 24h — even the most
          // extreme real transitions (e.g. a whole-day skip at the International Date Line) don't
          // occur for any zone this codebase's stores.timezone would realistically hold.
          const hours = (to.getTime() - from.getTime()) / (60 * 60 * 1000);
          expect(hours).toBeGreaterThanOrEqual(23);
          expect(hours).toBeLessThanOrEqual(25);
        }
      )
    );
  });
});

describe('resolveUtcCronForLocalTime', () => {
  it('America/New_York in August (EDT, UTC-4): 06:00 local -> 10:00 UTC', () => {
    // Independently confirmed via Intl.DateTimeFormat longOffset before writing this expectation:
    // GMT-04:00 for a mid-August instant.
    const reference = new Date('2026-08-15T12:00:00Z');
    expect(resolveUtcCronForLocalTime(reference, 'America/New_York', 6, 0)).toEqual({ hour: 10, minute: 0 });
  });

  it('America/New_York in January (EST, UTC-5): 06:00 local -> 11:00 UTC -- the DST case fact-aggregation\'s own fixed-cron precedent cannot handle', () => {
    // Independently confirmed: GMT-05:00 for a mid-January instant -- the SAME timezone, a
    // DIFFERENT real offset, which is the whole reason this function re-derives per call rather
    // than caching a timezone's offset once.
    const reference = new Date('2026-01-15T12:00:00Z');
    expect(resolveUtcCronForLocalTime(reference, 'America/New_York', 6, 0)).toEqual({ hour: 11, minute: 0 });
  });

  it('a timezone AHEAD of UTC wraps into the PREVIOUS UTC day (Asia/Tokyo, UTC+9): 06:00 local -> 21:00 UTC', () => {
    // Independently confirmed: GMT+09:00. 06:00 - 09:00 = -03:00, which wraps to 21:00 the
    // previous UTC day -- the modulo-wrap arithmetic's own real edge case.
    const reference = new Date('2026-08-15T12:00:00Z');
    expect(resolveUtcCronForLocalTime(reference, 'Asia/Tokyo', 6, 0)).toEqual({ hour: 21, minute: 0 });
  });

  it('a half-hour UTC offset (Asia/Kolkata, UTC+5:30) produces a real non-zero minute', () => {
    // Independently confirmed: GMT+05:30. 06:00 - 05:30 = 00:30 UTC.
    const reference = new Date('2026-08-15T12:00:00Z');
    expect(resolveUtcCronForLocalTime(reference, 'Asia/Kolkata', 6, 0)).toEqual({ hour: 0, minute: 30 });
  });

  it('is a real property: every result is a valid hour/minute pair, regardless of timezone or reference date', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
        fc.constantFrom('UTC', 'America/New_York', 'Asia/Tokyo', 'Asia/Kolkata', 'Pacific/Chatham', 'Australia/Sydney'),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        (ms, timezone, localHour, localMinute) => {
          const { hour, minute } = resolveUtcCronForLocalTime(new Date(ms), timezone, localHour, localMinute);
          expect(hour).toBeGreaterThanOrEqual(0);
          expect(hour).toBeLessThanOrEqual(23);
          expect(minute).toBeGreaterThanOrEqual(0);
          expect(minute).toBeLessThanOrEqual(59);
        }
      )
    );
  });
});
