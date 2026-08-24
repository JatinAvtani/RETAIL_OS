import Decimal from 'decimal.js';
import type { MetricUnit } from '@retailos/metrics';

/**
 * Every string form a real bundle value could plausibly appear as in the model's own prose. The
 * validator's allowlist is built from this — a narration response citing any of these forms is
 * grounded; anything else with a numeric shape is a real violation.
 *
 * `unit === 'CURRENCY'` deliberately generates NO `$`/`€`/`£`-prefixed variant — `MetricResult`
 * carries no currency code at all (only the unit label `'CURRENCY'`, a real finding from building
 * narration), so `narrate`'s own prompt never emits a currency symbol today either. Pre-allowing a
 * symbol the system has no real basis to attach would widen "grounded" beyond what this codebase
 * actually knows — a real future change (adding a currency code to `MetricResult`) should extend
 * this function deliberately, not have it already half-anticipate a shape nothing else produces
 * yet.
 */
const withThousandsSeparator = (value: string): string => {
  const parts = value.split('.');
  const intPart = parts[0] ?? '';
  const fracPart = parts[1];
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fracPart !== undefined ? `${withCommas}.${fracPart}` : withCommas;
};

/**
 * The Indian grouping convention: last three digits, then pairs — `407619.31` reads as
 * `4,07,619.31` (four lakh seven thousand...), not `407,619.31`.
 *
 * This exists in the ALLOWLIST rather than as a formatting step because the validator, not a
 * formatter, is what decides which numeric forms a narration may contain. Without it the model has
 * no grouped form it is permitted to write for an INR figure, so it falls back to the raw bundle
 * value and the briefing reads "your dead stock value is 407619.3100" — technically grounded,
 * genuinely unreadable.
 *
 * Both conventions stay allowed: the bundle carries no currency code (see the note above), so the
 * validator cannot know which one is right for a given figure, and rejecting a correctly-grouped
 * number would be a false violation.
 */
const withIndianSeparator = (value: string): string => {
  const parts = value.split('.');
  const intPart = parts[0] ?? '';
  const fracPart = parts[1];
  const negative = intPart.startsWith('-');
  const digits = negative ? intPart.slice(1) : intPart;

  const grouped =
    digits.length <= 3
      ? digits
      : `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-3)}`;

  const withSign = negative ? `-${grouped}` : grouped;
  return fracPart !== undefined ? `${withSign}.${fracPart}` : withSign;
};

const abbreviatedForm = (decimal: Decimal): string | null => {
  const abs = decimal.abs();
  if (abs.gte(1_000_000)) return `${decimal.div(1_000_000).toDecimalPlaces(1).toString()}m`;
  if (abs.gte(1_000)) return `${decimal.div(1_000).toDecimalPlaces(1).toString()}k`;
  return null;
};

export const formatVariants = (value: string, unit: MetricUnit): string[] => {
  const decimal = new Decimal(value);
  const variants = new Set<string>();

  // The exact string stored on the MetricResult itself — always allowed, always the baseline.
  variants.add(value);

  // The same numeric value at common alternate decimal precisions a model might round to.
  variants.add(decimal.toString()); // Decimal's own minimal-digits form, e.g. "1234.56" not "1234.5600"
  variants.add(decimal.toFixed(0));
  variants.add(decimal.toFixed(1));
  variants.add(decimal.toFixed(2));

  // Grouped forms of every precision variant generated so far, in BOTH conventions — the bundle
  // carries no currency code, so the validator cannot know which grouping a given figure warrants.
  for (const v of [...variants]) {
    variants.add(withThousandsSeparator(v));
    variants.add(withIndianSeparator(v));
  }

  const abbreviated = abbreviatedForm(decimal);
  if (abbreviated) variants.add(abbreviated);

  if (unit === 'PERCENTAGE') {
    for (const v of [...variants]) variants.add(`${v}%`);
  }

  return [...variants];
};
