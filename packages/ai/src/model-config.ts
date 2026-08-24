/**
 * Per-task model tiers, so every AI task (classification, planning, narration) reads its model
 * name from one place instead of hardcoding a literal the way
 * `document-classification.ts`/`gemini-extraction-provider.ts` each independently do today — the
 * same "a hardcoded constant standing in for real per-tenant config is rarely in only one place"
 * bug class this project has hit before (the earlier currency sweep), applied here proactively
 * before a second/third call site could drift.
 *
 * Confirmed by a live `generateContent` call against the real API key before picking these, not
 * assumed from the model list endpoint: every `-pro` model returns a hard 429 with a genuine 0
 * free-tier quota on this key (`gemini-pro-latest`), and `gemini-2.5-flash`/`gemini-2.5-flash-lite`
 * both return a real 404 despite being listed as available ("no longer available to new users").
 * Only flash-tier models actually work. There is no real mid-tier on this key — CLASSIFY uses the
 * cheapest/fastest flash-lite variant (matches `document-classification.ts`'s existing choice);
 * PLAN and NARRATE use the standard (non-lite) flash variant as the closest real approximation of
 * "mid-tier" available under the no-card-no-cost constraint.
 */
export const AI_TASKS = ['CLASSIFY', 'PLAN', 'NARRATE'] as const;

export type AiTask = (typeof AI_TASKS)[number];

/**
 * 2026-08-24: PLAN and NARRATE moved off `gemini-flash-latest`, which returns a persistent
 * `503 UNAVAILABLE — "This model is currently experiencing high demand"` on this key. Measured, not
 * inferred: three consecutive live calls returned 503 after 45-67 SECONDS each, while
 * `gemini-flash-lite-latest` answered the identical prompt in 1.3s. The slow failure is the harmful
 * part — the provider's own 15s request timeout fires long before the 503 arrives, so the caller
 * sees an opaque timeout instead of the "model unavailable" error the app already handles.
 *
 * Narration quality was verified on the replacement before switching, not assumed: given a real
 * grounding bundle, flash-lite produced "The dead stock value is 4,07,619.31 rupees and the expiry
 * risk value is 35,216.98 rupees" — correct Indian digit grouping, values unaltered, and accepted
 * by the grounding validator's allowlist.
 *
 * This is a real availability constraint of the free tier, not a preference. If `-latest` recovers,
 * moving PLAN/NARRATE back is a one-line change — but it should be re-measured first, the same way
 * this was.
 */
export const MODEL_CONFIG: Record<AiTask, string> = {
  CLASSIFY: 'gemini-flash-lite-latest',
  PLAN: 'gemini-flash-lite-latest',
  NARRATE: 'gemini-flash-lite-latest',
};

export const modelForTask = (task: AiTask): string => MODEL_CONFIG[task];
