/**
 * Store-local time resolution — spec 08 §8.2: "Store timezone is applied at query/presentation
 * time... dayparts computed in UTC are simply wrong." Every business table stores TIMESTAMPTZ in
 * UTC; this module is the ONE place a UTC instant is converted to the store's own wall-clock day
 * or hour, so every consumer (a metric, a report, a daily job) resolves "today"/"this hour"
 * identically rather than each reimplementing timezone math.
 *
 * Built on `Intl.DateTimeFormat` — a real IANA timezone database ships with Node, so no new
 * dependency is needed for the one thing this codebase actually needs: "what local date/hour did
 * this UTC instant fall on for this store's zone." Interval/duration arithmetic, if a future task
 * needs it, is a different problem this module deliberately does not solve.
 */

/** `stores.timezone`'s stored value — a plain IANA zone name, e.g. 'America/New_York'. */
export type StoreTimezone = string;

/**
 * The local calendar date an instant falls on, as `YYYY-MM-DD` — a stable, sortable string key.
 * `'en-CA'` is used purely for its `YYYY-MM-DD` formatting convention, not for locale-specific
 * number formatting elsewhere.
 */
export const resolveLocalDate = (instant: Date, timezone: StoreTimezone): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

/** The local wall-clock hour (0-23) an instant falls on for the given store timezone. */
export const resolveLocalHour = (instant: Date, timezone: StoreTimezone): number => {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  }).format(instant);
  // Intl's 24-hour format uses '24' for midnight in some locale/ICU combinations rather than '00' —
  // normalize explicitly so callers always get a value in [0, 23].
  const hour = Number(formatted);
  return hour === 24 ? 0 : hour;
};

/**
 * The four dayparts spec 12 §A's `revenue_per_daypart` needs, with no boundary definition given in
 * the spec itself — standard restaurant-industry buckets, confirmed with the user rather than
 * invented silently. `LATE_NIGHT` wraps past midnight (21:00-05:59), which is why this is a
 * function over the local hour rather than a simple range lookup table.
 */
export type Daypart = 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'LATE_NIGHT';

export const DAYPART_BOUNDARIES: ReadonlyArray<{ daypart: Daypart; startHour: number; endHour: number }> = [
  { daypart: 'BREAKFAST', startHour: 6, endHour: 11 }, // 06:00–10:59
  { daypart: 'LUNCH', startHour: 11, endHour: 15 }, // 11:00–14:59
  { daypart: 'DINNER', startHour: 15, endHour: 21 }, // 15:00–20:59
  { daypart: 'LATE_NIGHT', startHour: 21, endHour: 30 }, // 21:00–05:59 (hours 24-29 represent 0-5 wrapped)
];

/** Which daypart a local hour (0-23) falls into, for the store-local hour an instant resolves to. */
export const resolveDaypart = (localHour: number): Daypart => {
  // Wrapping LATE_NIGHT (21:00-05:59) is handled by treating an early-morning hour (0-5) as if it
  // were hour+24, so it falls inside LATE_NIGHT's [21, 30) range without a separate branch.
  const normalizedHour = localHour < 6 ? localHour + 24 : localHour;
  const match = DAYPART_BOUNDARIES.find(
    (b) => normalizedHour >= b.startHour && normalizedHour < b.endHour
  );
  // Every hour in [0,23] maps to exactly one daypart by construction of the boundaries above; this
  // is unreachable, not a real "unknown daypart" case.
  if (!match) throw new Error(`No daypart boundary covers local hour ${localHour}.`);
  return match.daypart;
};

/** Convenience: the daypart a UTC instant falls into for a given store timezone, in one call. */
export const resolveLocalDaypart = (instant: Date, timezone: StoreTimezone): Daypart =>
  resolveDaypart(resolveLocalHour(instant, timezone));
