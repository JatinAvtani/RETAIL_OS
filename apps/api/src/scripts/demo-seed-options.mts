export interface DemoSeedOptions {
  readonly limitDays: number | null;
  readonly maxReceiptsPerStoreDay: number | null;
}

const readIntegerFlag = (
  args: readonly string[],
  flag: string,
  options: { allowZero: boolean }
): number | null => {
  const prefix = `--${flag}=`;
  const matches = args.filter((arg) => arg.startsWith(prefix));

  if (matches.length > 1) {
    throw new Error(`Pass ${prefix}<integer> at most once.`);
  }
  if (matches.length === 0) return null;

  const raw = matches[0]!.slice(prefix.length);
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`${prefix}<integer> must be a whole number, received "${raw}".`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (!options.allowZero && value === 0)) {
    const requirement = options.allowZero ? 'a non-negative safe integer' : 'a positive safe integer';
    throw new Error(`${prefix}<integer> must be ${requirement}, received "${raw}".`);
  }
  return value;
};

export const parseDemoSeedOptions = (args: readonly string[]): DemoSeedOptions => ({
  limitDays: readIntegerFlag(args, 'limit-days', { allowZero: true }),
  maxReceiptsPerStoreDay: readIntegerFlag(args, 'max-receipts-per-store-day', { allowZero: false }),
});

/** `limitDays` is a count: 14 means today plus the preceding 13 days. */
export const isWithinDemoWindow = (daysAgo: number, limitDays: number | null): boolean =>
  limitDays === null || daysAgo < limitDays;

/**
 * Keep at most N receipts from every store-day, preserving corpus order.
 *
 * A plain `receipts.slice(0, N)` would keep only the oldest day in a file and destroy the trend
 * window a quick demo is meant to exercise. Grouping by store and relative day keeps a bounded,
 * deterministic sample across the entire selected period.
 */
export const capReceiptsPerStoreDay = <T extends { readonly storeCode: string; readonly daysAgo: number }>(
  receipts: readonly T[],
  maximum: number | null
): T[] => {
  if (maximum === null) return [...receipts];

  const countByStoreDay = new Map<string, number>();
  return receipts.filter((receipt) => {
    const key = `${receipt.storeCode}:${receipt.daysAgo}`;
    const count = countByStoreDay.get(key) ?? 0;
    if (count >= maximum) return false;
    countByStoreDay.set(key, count + 1);
    return true;
  });
};
