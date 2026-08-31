import { describe, expect, it } from 'vitest';
import {
  capReceiptsPerStoreDay,
  isWithinDemoWindow,
  parseDemoSeedOptions,
} from './demo-seed-options.mjs';

describe('parseDemoSeedOptions', () => {
  it('leaves the full-corpus profile unchanged when no limits are supplied', () => {
    expect(parseDemoSeedOptions(['--dry-run'])).toEqual({
      limitDays: null,
      maxReceiptsPerStoreDay: null,
    });
  });

  it('accepts the bounded reviewer profile', () => {
    expect(
      parseDemoSeedOptions(['--limit-days=14', '--max-receipts-per-store-day=20'])
    ).toEqual({ limitDays: 14, maxReceiptsPerStoreDay: 20 });
  });

  it.each([
    ['--limit-days=-1'],
    ['--limit-days=1.5'],
    ['--limit-days='],
    ['--max-receipts-per-store-day=0'],
    ['--max-receipts-per-store-day=lots'],
    ['--limit-days=7', '--limit-days=14'],
  ])('rejects an unsafe or ambiguous profile: %s', (...args) => {
    expect(() => parseDemoSeedOptions(args)).toThrow();
  });

  it('treats --limit-days as an exact count including today', () => {
    expect(isWithinDemoWindow(0, 14)).toBe(true);
    expect(isWithinDemoWindow(13, 14)).toBe(true);
    expect(isWithinDemoWindow(14, 14)).toBe(false);
    expect(isWithinDemoWindow(180, null)).toBe(true);
  });
});

describe('capReceiptsPerStoreDay', () => {
  const receipts = [
    { id: 'a1', storeCode: 'A', daysAgo: 2 },
    { id: 'a2', storeCode: 'A', daysAgo: 2 },
    { id: 'a3', storeCode: 'A', daysAgo: 2 },
    { id: 'a4', storeCode: 'A', daysAgo: 1 },
    { id: 'a5', storeCode: 'A', daysAgo: 1 },
    { id: 'b1', storeCode: 'B', daysAgo: 2 },
    { id: 'b2', storeCode: 'B', daysAgo: 2 },
  ] as const;

  it('keeps a deterministic sample from every store-day', () => {
    expect(capReceiptsPerStoreDay(receipts, 2).map((receipt) => receipt.id)).toEqual([
      'a1',
      'a2',
      'a4',
      'a5',
      'b1',
      'b2',
    ]);
  });

  it('does not alter the full profile', () => {
    expect(capReceiptsPerStoreDay(receipts, null)).toEqual(receipts);
  });
});
