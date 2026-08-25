import type { AuthContext } from '@retailos/authz';
import type { AccessibleProduct, AccessibleStore } from '../resolve-store-params';
import type { MetricContext } from '@retailos/metrics';
import type { IntentType } from '@retailos/ai';

/**
 * "Unmeasured AI quality is a claim, not a fact." A golden question set + scorer
 * that runs the REAL pipeline (`runPipeline` → `narrateAndValidate`/`buildRefusal`) end to end and
 * checks the result against a declared expectation, rather than asserting the internals of any one
 * stage in isolation — every other `packages/assistant` test file already does that.
 *
 * **Deliberately scoped to what this codebase can actually answer today, confirmed via
 * a deliberate scope cut**: the full golden dataset (150–300
 * questions spanning metric/retrieval/hybrid/ambiguous/unanswerable/adversarial, with a Recall@8
 * gate) assumed retrieval existed before it did. Every `RETRIEVAL`/`HYBRID` question
 * in this codebase today can only ever produce an honest `unsupported` refusal — there is no
 * retrieved passage to measure recall against. Building fake retrieval questions now would either
 * grade a capability that doesn't exist, or silently pad the golden-set count with cases that only
 * ever test the SAME "honest refusal" path a genuine unanswerable-question case already covers.
 * This module covers three categories only: `METRIC` (a real business number gets computed and
 * cited correctly), `REFUSAL` (an unanswerable question is refused honestly, per the refusal design's
 * `buildRefusal`), and `INJECTION` (an adversarial question does not produce a policy violation,
 * per the untrusted-input delimiting). `RETRIEVAL`/`HYBRID` questions are explicitly out of scope here — a
 * real follow-up now that retrieval exists, not silently dropped (see this module's own README-style
 * comment in `golden-set.ts`).
 */
export type EvalCategory = 'METRIC' | 'REFUSAL' | 'INJECTION';

export type MetricExpectation = {
  category: 'METRIC';
  /** The metric id(s) a correct plan should select — order-independent. Matches the design's
   * "metric selection accuracy" gate. */
  expectedMetricIds: string[];
  /** True when the question should produce real (non-`unknown`) cited values — false for a
   * deliberately data-starved fixture where the metric runs but legitimately resolves to
   * `'unknown'` (still a correct METRIC-category result, just an honest unknown one). */
  expectRealValue: boolean;
};

export type RefusalExpectation = {
  category: 'REFUSAL';
  /** What kind of gap this question's fixture is designed to hit — matches
   * `RefusalCategory` in `refusal.ts`. Used to assert the refusal explains the RIGHT reason, not
   * just that some refusal happened. */
  expectedRefusalCategory: 'unknown_metric_value' | 'permission_denied' | 'invalid_selection';
};

export type InjectionExpectation = {
  category: 'INJECTION';
  /** The fabricated/instruction-override content embedded in the question — asserted to survive
   * VERBATIM inside the delimited block of every prompt this question reaches, never stripped,
   * silently rewritten, or (the real failure mode this category exists to catch) OBEYED. */
  injectedInstructionFragment: string;
};

export type EvalExpectation = MetricExpectation | RefusalExpectation | InjectionExpectation;

export type EvalCase = {
  id: string;
  question: string;
  /** The intent `classifyIntent` should real-world settle on for this question — a genuinely
   * wrong classification routes the whole question down the wrong pipeline, so this is checked
   * independently of the category-specific expectation below. */
  expectedIntent: IntentType;
  expectation: EvalExpectation;
  /** Some real gap classes (`permission_denied`) only exist for a caller lacking a specific
   * permission — the suite's own default `AuthContext` (typically an unrestricted OWNER, so
   * METRIC cases can actually succeed) would never produce that gap. A PARTIAL override, merged
   * onto `EvalRunDeps.auth` (never replacing `organizationId`/`userId`/`storeIds`, which only the
   * real caller running the suite against a real seeded org actually knows) — a golden-set case
   * can safely override just `permissions`/`role` without needing to know the real org id.
   * **Found the hard way**: a first live run of this suite reported a `permission_denied` case as
   * "at least partially answered" because it shared the suite-wide OWNER auth, which genuinely
   * does have the permission — not a bug in `buildRefusal`/`executeMetric`, a real gap in this
   * type not yet supporting per-case auth. */
  authOverride?: Partial<EvalRunDeps['auth']>;
};

export type EvalCaseResult = {
  caseId: string;
  question: string;
  /** True only when EVERY check for this case's category passed — intent, category-specific
   * expectation, and (for METRIC/REFUSAL) the grounding validator reporting no violation. */
  passed: boolean;
  /** Every individual check's own pass/fail + a human-readable reason — never collapsed into just
   * the boolean above, so a failure is diagnosable without re-running the case with a debugger. */
  checks: { name: string; passed: boolean; detail: string }[];
  /** The final text shown to a user for this case, or null if the pipeline discarded it
   * (grounded: false) — kept for manual review, not itself asserted on for METRIC/REFUSAL cases
   * (their checks are structural, not string-matching prose). */
  finalText: string | null;
};

export type EvalSummary = {
  total: number;
  passed: number;
  failed: number;
  /** Per-category pass rate — mirrors the design's own per-metric gates (metric selection accuracy,
   * refusal correctness, injection resistance) rather than one blended number that could hide a
   * category-specific regression. */
  byCategory: Record<EvalCategory, { total: number; passed: number }>;
  results: EvalCaseResult[];
};

/** Everything `runEvalSuite` needs beyond the question set itself — the real collaborators every
 * other `packages/assistant` integration test already threads through (`AuthContext`,
 * `MetricContext`, real model names), so a caller supplies real Postgres/real Gemini exactly the
 * way `pipeline.test.ts`'s own live-verification scripts already do, and this module adds no new
 * seam. */
export type EvalRunDeps = {
  auth: AuthContext;
  ctx: MetricContext;
  classifyModel: string;
  planModel: string;
  narrateModel: string;
  /** The real stores of the org this suite runs against. The eval must exercise the SAME store
   * resolution production does — a suite that skipped it would pass while the live assistant
   * fabricated a storeId, which is exactly the gap this list closes. */
  accessibleStores: AccessibleStore[];
  /** Real products of the org this suite runs against — without them the product-scoped metrics are
   * unreachable and their cases can never pass, which is exactly how they failed before. */
  accessibleProducts?: AccessibleProduct[];
};
