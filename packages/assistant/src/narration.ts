import type { ChatProvider } from '@retailos/ai';
import type { GroundingBundle } from './grounding-bundle';
import type { DeniedSelection, FailedSelection } from './execute-selections';
import type { RejectedSelection } from './planning';

/**
 * "NARRATE (LLM) → prompt contains ONLY the grounding bundle → instruction: use only supplied
 * values; cite each; refuse if insufficient." Reuses `ChatProvider.generate` — plain text in,
 * plain text out — which has existed since this package's provider abstraction was built, with no
 * real caller until now.
 *
 * **The prompt contains ONLY the bundle's own values — never raw database rows, never anything
 * the model could use to compute a NEW number itself (I1).** Each metric is presented as a
 * pre-formatted string (id, value, unit, period, freshness) the model can cite verbatim; it is
 * never given the underlying rows a metric was computed from. This is both the safety property
 * intended here and the real reason `MetricResult` already carries a human-legible `value` string
 * rather than a raw number this function would need to format itself (formatting is a
 * business-number-adjacent operation this codebase keeps out of `packages/ai`).
 *
 * `narrate` itself still does NO validation of its own output — it produces a real, honest prompt
 * and passes back exactly what the model returned. **`validateGrounding`/`narrateAndValidate`
 * (`validate-grounding.ts`) is the real enforcement layer**; calling `narrate` directly and
 * trusting its `text` without going through `narrateAndValidate` would skip the validator
 * entirely — a real, avoidable mistake, not a gap this file needs to re-solve.
 *
 * This function DOES handle the empty/insufficient case itself, not punt entirely to a later
 * insufficient-data refusal path — matching the "refuse if insufficient" instruction as real scope
 * for narration itself. When `bundle.metrics` is empty, the prompt instructs the model to explain
 * what's missing using the real `denied`/`failed`/`rejected` reasons if any exist, never to guess
 * or invent an answer. A later stage can build a more structured, deterministic refusal UI without
 * this leaving a genuine hole in the meantime — every call still goes through this same real
 * `generate` path.
 */
export type NarrationResult = {
  provider: string;
  modelVersion: string;
  error: string | null;
  text: string | null;
};

/**
 * `MetricResult` carries no currency code — only `unit: 'CURRENCY'` — so this cannot invent a
 * currency symbol (a real, live test caught the awkward "4582.7500 CURRENCY" output this was
 * fixing; adding a fabricated `$` would be worse, a genuinely wrong claim about the org's real
 * currency, not just unpolished prose). `PERCENTAGE`/`RATIO` get real, common suffixes since those
 * units carry no ambiguity the way currency does.
 */
const formatUnit = (value: string, unit: GroundingBundle['metrics'][number]['unit']): string => {
  switch (unit) {
    case 'PERCENTAGE':
      return `${value}%`;
    case 'RATIO':
      return `${value}x`;
    case 'DAYS':
      return `${value} days`;
    case 'COUNT':
      return value;
    case 'CURRENCY':
      return `${value} (currency unit not tracked by this metric)`;
  }
};

const formatMetric = (m: GroundingBundle['metrics'][number]): string => {
  const period = `${m.period.from.toISOString().slice(0, 10)} to ${m.period.to.toISOString().slice(0, 10)}`;
  if (m.value === 'unknown') {
    return `- ${m.metricId}: unknown (${m.unknownReason ?? 'no reason given'}), period ${period}`;
  }
  return `- ${m.metricId}: ${formatUnit(m.value, m.unit)}, period ${period}, as of ${m.freshness.toISOString()}`;
};

const formatGaps = (denied: DeniedSelection[], failed: FailedSelection[], rejected: RejectedSelection[]): string => {
  const lines: string[] = [];
  for (const d of denied) lines.push(`- ${d.metricId}: not answered — the caller does not have permission to view this (${d.reason})`);
  for (const f of failed) lines.push(`- ${f.metricId}: not answered — an internal error occurred (${f.reason})`);
  for (const r of rejected) lines.push(`- ${r.metricId}: not answered — this could not be computed as requested (${r.reason})`);
  return lines.length > 0 ? lines.join('\n') : 'None.';
};

/**
 * `strict` is the validator's own regenerate-once mechanism ("VIOLATION → regenerate once with
 * a stricter prompt"). The extra instruction block is appended, not substituted, so a strict
 * retry still contains every rule the first attempt had — this is additive emphasis, not a
 * different prompt with different rules the model might interpret differently.
 */
const STRICT_ADDENDUM = `

IMPORTANT — your previous answer included a number that did not exactly match one of the values listed above. This is a serious error. Re-read the "Computed metrics available" list above very carefully. Every single digit you write must be copied EXACTLY from that list — do not round, do not estimate, do not combine two values into a new one. If you cannot express the answer using only those exact values, say so explicitly instead of writing any number.`;

const buildPrompt = (bundle: GroundingBundle, denied: DeniedSelection[], failed: FailedSelection[], rejected: RejectedSelection[], strict: boolean): string => {
  const metricsBlock = bundle.metrics.length > 0 ? bundle.metrics.map(formatMetric).join('\n') : 'None.';
  const gapsBlock = formatGaps(denied, failed, rejected);

  return `You are a business assistant answering a question for a restaurant/café owner or manager. You do NOT compute any number yourself — every figure below is already computed and verified. You must ONLY use the exact values given here.

Computed metrics available to answer this question:
${metricsBlock}

Things that could NOT be answered:
${gapsBlock}

Rules:
- Use ONLY the exact values listed above. Never calculate, estimate, round differently, or derive a new number from them.
- Cite each figure by naming the metric it came from.
- If "Computed metrics available" is "None." or doesn't actually answer the question, say so honestly and explain what's missing using the "Things that could NOT be answered" list if relevant — never guess or make up a plausible-sounding answer.
- Write in plain, concise language a busy restaurant owner would understand. No jargon.
- Plain prose only — no markdown (no asterisks, backticks, bullets, or headings); your text renders exactly as written. Name each metric in ordinary words ("expiry risk value"), never its internal snake_case id.${strict ? STRICT_ADDENDUM : ''}`;
};

export const narrate = async (
  provider: ChatProvider,
  bundle: GroundingBundle,
  denied: DeniedSelection[],
  failed: FailedSelection[],
  rejected: RejectedSelection[],
  model: string,
  strict = false
): Promise<NarrationResult> => {
  const result = await provider.generate(buildPrompt(bundle, denied, failed, rejected, strict), model);
  return { provider: result.provider, modelVersion: result.modelVersion, error: result.error, text: result.text };
};
