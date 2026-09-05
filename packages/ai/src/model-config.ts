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
 * 2026-09-04: switched all three tasks off the `-latest` ALIAS onto the real, versioned
 * `gemini-3.5-flash-lite` tag — a floating alias means Google can silently swap the underlying
 * model under this app at any time with zero warning (the exact "unpinned model/config version"
 * gap an external audit flagged); a versioned tag cannot move underneath the app the same way,
 * even though Google will eventually retire it outright (as it already did to
 * `gemini-2.5-flash-lite`, confirmed via a live 404: "no longer available to new users... use
 * models/gemini-3.5-flash-lite"). Verified live before switching, matching the discipline this
 * comment already established: `models?key=...` confirmed the tag exists on this key; 3
 * consecutive live narration calls with a real grounding-shaped prompt (dead stock / expiry risk
 * figures) each completed in ~1.2-1.3s (no regression vs. `-latest`'s own measured 1.3s) with
 * correct Indian digit grouping and unaltered values every time; a real structured-output
 * (`responseSchema`) call correctly classified a sample question as METRIC.
 *
 * A real A/B eval run against the 18-case golden set (`pnpm --filter @retailos/api eval`)
 * independently confirmed the switch is a genuine improvement, not just a lateral move: on
 * `gemini-3.5-flash-lite`, 14/18 cases passed in ~3 minutes. The SAME run against
 * `gemini-flash-lite-latest` was killed after running for OVER 20 MINUTES with zero output —
 * reproducing, live, the exact `-latest`-alias hang failure this file's 2026-08-24 entry above
 * already documented for the non-lite variant, this time on the lite alias too. This is decisive
 * evidence for pinning: the floating alias is not just an unpinned-version risk in the abstract,
 * it is measurably, currently less reliable than the versioned tag on this key.
 *
 * If this tag is ever retired, re-measure the replacement the same way before switching, not just
 * for availability but for quality — a working model is not automatically an equally correct one.
 */
/**
 * 2026-09-04, later the same day: `gemini-3.5-flash-lite` (pinned above, same day) started
 * hanging on every real `generateContent` call — not a 429 (quota), not a 404 (model missing):
 * the TCP connection succeeds, the request sends, and the server returns literally nothing until
 * the client's own timeout fires. Confirmed directly against the raw API with curl (bypassing this
 * app entirely) before touching this file: `models?key=...` returns instantly (the key and model
 * list endpoint both work), a `generateContent` call to `gemini-3.5-flash-lite` hangs 15s+ with
 * zero response (three separate attempts, both via this app's real pipeline and via a direct raw
 * curl call), while the SAME request shape against `gemini-3.1-flash-lite` returns a real 200 in
 * under a second, twice, including a `responseSchema` structured-output call matching what PLAN/
 * CLASSIFY actually need. This is model-side instability on Google's end for this specific tag,
 * not a config or quota problem on this key — `gemini-3.5-flash-lite` may recover; re-measure
 * before switching back, per this file's own standing discipline.
 */
export const MODEL_CONFIG: Record<AiTask, string> = {
  CLASSIFY: 'gemini-3.1-flash-lite',
  PLAN: 'gemini-3.1-flash-lite',
  NARRATE: 'gemini-3.1-flash-lite',
};

export const modelForTask = (task: AiTask): string => MODEL_CONFIG[task];
