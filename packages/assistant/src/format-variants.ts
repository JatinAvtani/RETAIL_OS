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

  // Thousands-separated forms of every precision variant generated so far.
  for (const v of [...variants]) variants.add(withThousandsSeparator(v));

  const abbreviated = abbreviatedForm(decimal);
  if (abbreviated) variants.add(abbreviated);

  if (unit === 'PERCENTAGE') {
    for (const v of [...variants]) variants.add(`${v}%`);
  }

  return [...variants];
};
