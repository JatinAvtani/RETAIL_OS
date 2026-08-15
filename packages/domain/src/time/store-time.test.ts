import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { resolveDaypart, resolveLocalDate, resolveLocalDaypart, resolveLocalHour } from './store-time.js';

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
