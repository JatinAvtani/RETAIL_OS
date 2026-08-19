import type { ChatProvider } from '@retailos/ai';
import type { GroundingBundle } from './grounding-bundle';
import { formatVariants } from './format-variants';
import { extractNumericTokens } from './extract-numeric-tokens';
import { narrate, type NarrationResult } from './narration';
import type { DeniedSelection, FailedSelection } from './execute-selections';
import type { RejectedSelection } from './planning';

/**
 * ⚠️ **THE CORE SAFETY MECHANISM**: "extract every numeric token from the response → each must
 * match a bundle value (within formatting tolerance) → VIOLATION → regenerate once → SECOND
 * VIOLATION → discard prose, render structured results only." This is the ONLY thing standing
 * between a narration response and a user — no number `narrate` ever produces is trusted until it
 * passes this check.
 *
 * `normalize` strips exactly what `formatVariants` adds — thousands separators and a
 * trailing `%` — so both sides of the comparison collapse to the same canonical form regardless
 * of which specific variant either side happened to use.
 */
const normalize = (token: string): string => token.replace(/,/g, '').replace(/%$/, '');

export type ValidationResult =
  | { ok: true }
  | { ok: false; violations: string[] };

/**
 * Pure, deterministic, no model involvement (I1/I3) — the whole point of this function existing
 * separately from `narrate`. The bundle's CONTENT is the only source of truth for what's allowed:
 * computed metric values (with formatting tolerance), plus numeric tokens appearing VERBATIM in a
 * retrieved passage's text. A passage number is grounded-by-source — the reader can open the cited
 * document and see it — which is a different kind of grounding from a computed metric, but still
 * traceable to real bundle content; the gate exists to stop numbers from NOWHERE. Passage tokens
 * get no formatting variants: quoting a source figure any way other than exactly as written is a
 * distortion of the source, and flagging it is correct. A `denied`/`failed`/`rejected` reason
 * string is prose the model is ALLOWED to reference by name (e.g. "financial:read"), but any
 * numbers embedded in those reason strings are NOT added to the allowlist — they describe why
 * something couldn't be computed, they are not themselves grounded figures.
 */
export const validateGrounding = (response: string, bundle: GroundingBundle): ValidationResult => {
  const allowed = new Set([
    ...bundle.metrics.flatMap((m) => (m.value === 'unknown' ? [] : formatVariants(m.value, m.unit).map(normalize))),
    ...bundle.passages.flatMap((p) => extractNumericTokens(p.text).map(normalize)),
  ]);

  const found = extractNumericTokens(response);
  const violations = found.filter((token) => !allowed.has(normalize(token)));

  return violations.length > 0 ? { ok: false, violations } : { ok: true };
};

export type NarrateAndValidateResult = {
  /** The final text to show the user. `null` only when the model itself never returned usable text at all (a provider error on every attempt) — the fail-closed discard case still returns real structured data via `bundle`, never null text standing in for a real answer. */
  text: string | null;
  /** True only when a genuinely grounded response was produced (first or second attempt). False for a provider error OR a second grounding violation — the caller renders `bundle` directly in either case, never trusting `text`. */
  grounded: boolean;
  /** Every violation from every attempt, in order — logged even when the final attempt succeeds, since a first-attempt violation is real signal about prompt/model quality (the "every violation is logged" requirement) even after a successful regenerate. */
  violationLog: { attempt: number; response: string; violations: string[] }[];
};

/**
 * The fail-closed wrapper this design names explicitly: narrate, validate, and on a violation
 * regenerate ONCE with a stricter prompt; a second violation discards the prose entirely rather
 * than ever serving an ungrounded response. This is the real integration point between narration
 * and the validator — `narrate` on its own was never safe to expose to a user; this function is
 * what makes it safe.
 */
export const narrateAndValidate = async (
  provider: ChatProvider,
  bundle: GroundingBundle,
  denied: DeniedSelection[],
  failed: FailedSelection[],
  rejected: RejectedSelection[],
  model: string
): Promise<NarrateAndValidateResult> => {
  const violationLog: NarrateAndValidateResult['violationLog'] = [];

  const attempt = async (strict: boolean): Promise<NarrationResult> =>
    narrate(provider, bundle, denied, failed, rejected, model, strict);

  const first = await attempt(false);
  if (first.error || !first.text) {
    return { text: null, grounded: false, violationLog };
  }

  const firstCheck = validateGrounding(first.text, bundle);
  if (firstCheck.ok) {
    return { text: first.text, grounded: true, violationLog };
  }
  violationLog.push({ attempt: 1, response: first.text, violations: firstCheck.violations });

  const second = await attempt(true);
  if (second.error || !second.text) {
    return { text: null, grounded: false, violationLog };
  }

  const secondCheck = validateGrounding(second.text, bundle);
  if (secondCheck.ok) {
    return { text: second.text, grounded: true, violationLog };
  }
  violationLog.push({ attempt: 2, response: second.text, violations: secondCheck.violations });

  // DISCARD the prose entirely — never serve a second-time-violating response, per this design's
  // explicit fail-closed intent. The caller falls back to bundle.metrics directly (structured,
  // already-grounded-by-construction data), never this function's own text.
  return { text: null, grounded: false, violationLog };
};
