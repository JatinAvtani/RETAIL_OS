/**
 * Finds every numeric-shaped token in a narration response that could be a claimed business
 * figure — "excludes: dates, ordinals, list numbering, years."
 *
 * **Ambiguous cases are biased toward FLAGGING, not excluding.** A token is only excluded when
 * there is STRONG, LOCAL evidence it's a date/ordinal/year/list marker — a bare `2026` with no
 * surrounding date-shaped context is NOT excluded just because it looks like a plausible year,
 * since the explicit priority here is that an undetected fabricated number is the one outcome
 * this product cannot survive, while a legitimate date getting flagged is a recoverable false
 * positive (regenerate once, then degrade to structured results — a deliberate fail-closed
 * design, not a crash or a wrong answer reaching a user).
 *
 * Two exclusion rules that once existed here were removed after probing this function with
 * adversarial responses (see the "adversarial responses" describe block in the test file):
 *
 * - **Quoted spans are NOT excluded.** An earlier rule skipped anything inside single/double
 *   quotes as "cited source text". That made `was "4200"` pass unvalidated, and — far worse —
 *   made any ordinary apostrophe (`the store's`) open a phantom single-quote span that swallowed
 *   every number after it for the rest of the response. A quoted number is still a numeric claim
 *   the reader will act on; if it isn't in the bundle it must flag.
 * - **Ordinals are capped at 3 digits.** `\d+(st|nd|rd|th)` let `4200th` smuggle an arbitrary
 *   figure past validation wearing an ordinal suffix. Real rankings this product narrates are
 *   small; a 4-digit "ordinal" is far more likely a disguised figure, so it flags.
 *
 * A leading minus sign is captured as part of the token (when it starts a number rather than
 * joining a range like "10-15"), so `-1000.00` can only validate against a bundle value that is
 * itself negative — without this, a sign-flipped figure ("you gained" vs "you lost") validated as
 * grounded against its own negation.
 *
 * **Known residual gap, deliberate:** numbers written out as words ("forty-two hundred") are not
 * detected. Reliable word-number extraction is a natural-language problem with a high
 * false-positive rate ("a hundred percent behind you" contains no figure), and the narration
 * prompt already instructs the model to copy digits exactly from the metrics list. The
 * deterministic validator guarantees no *digit-shaped* fabrication survives; prose-shaped
 * fabrication remains covered only by the prompt, and that boundary is stated here rather than
 * silently implied.
 */
const NUMERIC_TOKEN = /(?<=^|[\s(])[-−]\d[\d,]*(?:\.\d+)?%?|\d[\d,]*(?:\.\d+)?%?/g;

/** A real calendar-date-shaped substring around a token — "August 2026", "2026-08-01", "Aug 1, 2026". */
const DATE_CONTEXT = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?,?\s*\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{2,4}\b|\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi;

/**
 * A real ordinal — "1st", "2nd", "3rd", "21st" — the suffix is the strong local evidence, but only
 * up to 3 digits: see the header for why `4200th` must flag rather than exclude.
 */
const ORDINAL = /\b\d{1,3}(st|nd|rd|th)\b/gi;

/** A real list-numbering marker at the start of a line or after a bullet — "1. ", "2) ". */
const LIST_MARKER = /^\s*\d+[.)]\s+/gm;

const collectRanges = (text: string, pattern: RegExp): Array<[number, number]> => {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
};

const overlapsAny = (start: number, end: number, ranges: Array<[number, number]>): boolean =>
  ranges.some(([rStart, rEnd]) => start < rEnd && end > rStart);

export const extractNumericTokens = (response: string): string[] => {
  const excludedRanges = [
    ...collectRanges(response, DATE_CONTEXT),
    ...collectRanges(response, ORDINAL),
    ...collectRanges(response, LIST_MARKER),
  ];

  const tokens: string[] = [];
  for (const match of response.matchAll(NUMERIC_TOKEN)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (overlapsAny(start, end, excludedRanges)) continue;
    // The U+2212 minus normalizes to the ASCII hyphen so downstream comparison against bundle
    // values (which always use the ASCII form) is exact.
    tokens.push(match[0].replace(/−/, '-'));
  }
  return tokens;
};
