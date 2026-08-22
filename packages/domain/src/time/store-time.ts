/**
 * Store-local time resolution — the design: "Store timezone is applied at query/presentation
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
 * The four dayparts the design's `revenue_per_daypart` needs, with no boundary definition given in
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

/**
 * The real UTC offset (in minutes, positive = ahead of UTC) in effect for a given instant in a
 * given timezone — e.g. `America/New_York` is `-240` (EDT) in August, `-300` (EST) in January.
 * `longOffset` is the one `Intl.DateTimeFormat` format that returns a literal `GMT±HH:MM` string
 * rather than an abbreviation (`EDT`) or a UTC-relative name, so this needs no hardcoded
 * zone-name-to-offset table and stays correct across a DST transition automatically.
 */
const resolveUtcOffsetMinutes = (instant: Date, timezone: StoreTimezone): number => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' }).formatToParts(
    instant
  );
  const offsetPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offsetPart);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
};

/**
 * The UTC hour/minute that corresponds to a given LOCAL wall-clock time (e.g. "06:00") for
 * a store's timezone, evaluated using the real offset in effect AROUND `referenceDate` — the real
 * need this exists for: "06:00 store-local" scheduling (the daily briefing) needs a genuine
 * per-store UTC cron time, not fact-aggregation's own fixed-UTC-cron approximation (that job's
 * 05:00 UTC choice is a documented, accepted limitation for its own less time-sensitive deadline;
 * the briefing plan explicitly names "briefing at wrong local time" as a real risk to mitigate, a
 * stricter requirement). Returns hour/minute as the caller's own cron pattern fields
 * (`${minute} ${hour} * * *`), NOT a `Date` — the caller re-derives this on a repeating tick (see
 * `packages/queue/src/briefing-queue.ts`) so a store's schedule self-corrects across a DST
 * transition rather than drifting by an hour twice a year, the same reasoning
 * `resolveLocalDateRange` already applies to its own `from`/`to` boundary calculation.
 *
 * Deliberately re-derives the offset from `referenceDate` (typically "now," passed by the caller,
 * never read from `Date.now()` internally — this module has no clock of its own) rather than
 * caching a timezone's offset once: DST means the SAME timezone's UTC offset is a different value
 * in June than in January, and re-registering with the wrong cached offset would schedule the
 * briefing an hour early or late for roughly half the year.
 */
export const resolveUtcCronForLocalTime = (
  referenceDate: Date,
  timezone: StoreTimezone,
  localHour: number,
  localMinute: number
): { hour: number; minute: number } => {
  const offsetMinutes = resolveUtcOffsetMinutes(referenceDate, timezone);
  const totalLocalMinutes = localHour * 60 + localMinute;
  // UTC time-of-day = local time-of-day minus the local offset from UTC, wrapped into [0, 1440).
  const totalUtcMinutes = ((totalLocalMinutes - offsetMinutes) % 1440 + 1440) % 1440;
  return { hour: Math.floor(totalUtcMinutes / 60), minute: totalUtcMinutes % 60 };
};

/**
 * The `[from, to)` UTC instant range one store-local calendar date covers — earlier work's real need:
 * an incremental aggregation job resolves "yesterday" per store's own timezone (this project's
 * standing example: "a three-store group across two timezones has three different yesterdays,"
 * the plan Phase 1), then must query raw transactional tables (all stored TIMESTAMPTZ/UTC) for
 * exactly the UTC window that local day spans — never the UTC calendar day, which would silently
 * include/exclude hours at either edge for any timezone not at UTC+0.
 *
 * `from` = local midnight of `localDate`, converted to UTC using the real offset in effect AT that
 * date (not "now") — correct across a DST transition landing on the date's own boundary. `to` is
 * the same calculation for the NEXT calendar day, not `from + 24h` — a day with a DST transition
 * is genuinely 23 or 25 hours long in UTC terms, and a fixed 24h step would silently mis-bound one
 * hour of transactions into the wrong day's fact row twice a year.
 */
export const resolveLocalDateRange = (localDate: string, timezone: StoreTimezone): { from: Date; to: Date } => {
  const localMidnightUtc = (dateStr: string): Date => {
    const utcGuess = new Date(`${dateStr}T00:00:00Z`);
    const offsetMinutes = resolveUtcOffsetMinutes(utcGuess, timezone);
    return new Date(utcGuess.getTime() - offsetMinutes * 60 * 1000);
  };

  // The next CALENDAR date, computed by plain date arithmetic on `localDate` itself (a real
  // calendar-day increment, not a UTC-instant-plus-24h guess) — a fall-back DST day is a genuine
  // 25-hour day in UTC terms, so `from + 24h` can still land WITHIN the same local calendar day
  // (confirmed the hard way: `2026-11-01` in America/New_York is 25 real UTC hours, and
  // `from + 24h` resolves back to `2026-11-01`, not `2026-11-02`). Parsing `localDate` as a plain
  // UTC-midnight instant purely for calendar-day increment (never used as an actual UTC boundary)
  // sidesteps this entirely — it is timezone-independent arithmetic on the calendar date string.
  const nextLocalDate = new Date(`${localDate}T00:00:00Z`);
  nextLocalDate.setUTCDate(nextLocalDate.getUTCDate() + 1);
  const nextLocalDateStr = nextLocalDate.toISOString().slice(0, 10);

  const from = localMidnightUtc(localDate);
  const to = localMidnightUtc(nextLocalDateStr);
  return { from, to };
};
