/**
 * Finds every numeric-shaped token in a narration response that could be a claimed business
 * figure — "excludes: dates, ordinals, quoted source text, list numbering, years."
 *
 * **Ambiguous cases are biased toward FLAGGING, not excluding.** A token is only excluded when
 * there is STRONG, LOCAL evidence it's a date/ordinal/year/list marker — a bare `2026` with no
 * surrounding date-shaped context is NOT excluded just because it looks like a plausible year,
 * since the explicit priority here is that an undetected fabricated number is the one outcome
 * this product cannot survive, while a legitimate date getting flagged is a recoverable false
 * positive (regenerate once, then degrade to structured results — a deliberate fail-closed
 * design, not a crash or a wrong answer reaching a user).
 */
const NUMERIC_TOKEN = /\d[\d,]*(?:\.\d+)?%?/g;

/** A real calendar-date-shaped substring around a token — "August 2026", "2026-08-01", "Aug 1, 2026". */
const DATE_CONTEXT = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?,?\s*\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{2,4}\b|\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi;

/** A real ordinal — "1st", "2nd", "3rd", "21st" — the suffix itself is the strong local evidence. */
const ORDINAL = /\b\d+(st|nd|rd|th)\b/gi;

/** A real list-numbering marker at the start of a line or after a bullet — "1. ", "2) ". */
const LIST_MARKER = /^\s*\d+[.)]\s+/gm;

/** A real quoted span — content inside single/double/curly quotes is source text being cited, not a claim. */
const QUOTED_SPAN = /"[^"]*"|'[^']*'|"[^"]*"|'[^']*'/g;

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
    ...collectRanges(response, QUOTED_SPAN),
  ];

  const tokens: string[] = [];
  for (const match of response.matchAll(NUMERIC_TOKEN)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (overlapsAny(start, end, excludedRanges)) continue;
    tokens.push(match[0]);
  }
  return tokens;
};
