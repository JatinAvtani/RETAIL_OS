/**
 * onboarding health score — the plan's own `OnboardingHealth` shape made real. Pure
 * scoring/composition only (no I/O) — every input here is a value the caller has ALREADY computed
 * from real data (apps/api's health-score.ts orchestrates the actual queries); this module never
 * guesses a step's completion, it only combines already-honest booleans/ratios into a score,
 * blocker list, and stalled flag (I7 — the composition itself must not fabricate progress either).
 *
 * Two of the plan's eight named thresholds have no stable, storable denominator anywhere in this
 * codebase (confirmed before building, not assumed) and were narrowed with the user before this
 * module was written:
 *  - productsConfirmed/suppliersConfirmed "80%" is a LIVE re-detect ratio (confirmed / (confirmed +
 *    still-detectable-right-now)) — a real snapshot, not a stable historical percentage, since
 *    product/supplier detection is a stateless function with no persisted candidate-run history.
 *  - invoicesUploaded "30 days" measures "has an approved invoice from >=30 days ago" (upload-time
 *    based), not true chronological invoice-date coverage — the only real query available.
 */

const REQUIRED_RATIO = 0.8;
const STALLED_AFTER_DAYS = 3;

/** the plan's own "top 20 menu items" — the caller (apps/api) ranks by trailing quantity sold and passes only the resulting counts into this module, but the constant is defined once, here, so the ranking query and the doc string it's described by never drift apart. */
export const TOP_N_MENU_ITEMS_FOR_RECIPE_COVERAGE = 20;

export type OnboardingHealthInputs = {
  storeCreated: boolean;
  salesConnected: boolean;
  /** True when this org has at least one real approved invoice document dated >= 30 days ago (upload-time based — see module doc). */
  invoicesUploadedAtLeast30Days: boolean;
  /** Live re-detect ratio: confirmed / (confirmed + still-detectable). `null` when there is nothing to measure yet (zero confirmed AND zero detectable) — a genuine "unknown," never a fabricated 0 or 100 (I7). */
  productsConfirmedRatio: number | null;
  suppliersConfirmedRatio: number | null;
  /** Fraction of org-wide trailing sales revenue that comes from MAPPED pos_items. `null` when there is no sales volume at all yet to compute a ratio from. */
  posItemsMappedRatioByVolume: number | null;
  /** Of the top-N menu items by trailing quantity sold, how many currently have a valid recipe. `topMenuItemCount` is that same N (may be < TOP_N_MENU_ITEMS for a new org with few distinct items) — both 0 when no sales exist yet, a real "nothing to report," not an unknown. */
  recipesCreated: { withRecipe: number; topMenuItemCount: number };
  /** Of the SAME top-N menu items that have a valid recipe, how many have every one of their exploded component products covered by a real stock_par_levels row. */
  parLevelsSet: { fullyCovered: number; recipeCoveredMenuItemCount: number };
  /** The onboarding_progress row's own updatedAt — real signal for `stalled`; `null` when no row exists yet (a brand-new org that hasn't touched the wizard at all is not "stalled," it just hasn't started). */
  onboardingProgressUpdatedAt: Date | null;
  now: Date;
};

export type OnboardingHealthStepStatus = {
  done: boolean;
  /** `null` only for the two ratio-based steps when there is genuinely nothing to measure yet (I7) — every other step is a real boolean, never unknown. */
  ratio: number | null;
};

export type OnboardingHealth = {
  score: number;
  steps: {
    storeCreated: OnboardingHealthStepStatus;
    salesConnected: OnboardingHealthStepStatus;
    invoicesUploaded: OnboardingHealthStepStatus;
    productsConfirmed: OnboardingHealthStepStatus;
    suppliersConfirmed: OnboardingHealthStepStatus;
    posItemsMapped: OnboardingHealthStepStatus;
    recipesCreated: OnboardingHealthStepStatus;
    parLevelsSet: OnboardingHealthStepStatus;
  };
  blockers: string[];
  stalled: boolean;
};

const daysBetween = (from: Date, to: Date): number => (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);

/** A ratio step is "done" once it clears the required threshold; a null ratio (nothing to measure) is never done, never a blocker either — there's nothing actionable to report yet. */
const ratioStep = (ratio: number | null): OnboardingHealthStepStatus => ({
  done: ratio !== null && ratio >= REQUIRED_RATIO,
  ratio,
});

const booleanStep = (done: boolean): OnboardingHealthStepStatus => ({ done, ratio: null });

const safeRatio = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : numerator / denominator);

export const computeOnboardingHealth = (inputs: OnboardingHealthInputs): OnboardingHealth => {
  const recipesRatio = safeRatio(inputs.recipesCreated.withRecipe, inputs.recipesCreated.topMenuItemCount);
  const parLevelsRatio = safeRatio(inputs.parLevelsSet.fullyCovered, inputs.parLevelsSet.recipeCoveredMenuItemCount);

  const steps: OnboardingHealth['steps'] = {
    storeCreated: booleanStep(inputs.storeCreated),
    salesConnected: booleanStep(inputs.salesConnected),
    invoicesUploaded: booleanStep(inputs.invoicesUploadedAtLeast30Days),
    productsConfirmed: ratioStep(inputs.productsConfirmedRatio),
    suppliersConfirmed: ratioStep(inputs.suppliersConfirmedRatio),
    posItemsMapped: ratioStep(inputs.posItemsMappedRatioByVolume),
    recipesCreated: ratioStep(recipesRatio),
    parLevelsSet: ratioStep(parLevelsRatio),
  };

  const stepValues = Object.values(steps);
  const doneCount = stepValues.filter((s) => s.done).length;
  // Every step weighs equally — the plan names no per-step weighting, and inventing one (e.g.
  // "sales connection matters more than par levels") would be a fabricated business judgment this
  // task has no real basis for (I7 applied to the scoring formula itself, not just its inputs).
  const score = Math.round((doneCount / stepValues.length) * 100);

  const blockers: string[] = [];
  if (!steps.storeCreated.done) blockers.push('No store has been created yet.');
  if (!steps.salesConnected.done) blockers.push('No sales source (POS or CSV import) is connected yet.');
  if (!steps.invoicesUploaded.done) blockers.push('No approved invoices from 30+ days ago yet — upload more supplier invoice history.');
  if (inputs.productsConfirmedRatio !== null && !steps.productsConfirmed.done) {
    blockers.push(`Only ${Math.round(inputs.productsConfirmedRatio * 100)}% of detected products are confirmed — review the remaining candidates.`);
  }
  if (inputs.suppliersConfirmedRatio !== null && !steps.suppliersConfirmed.done) {
    blockers.push(`Only ${Math.round(inputs.suppliersConfirmedRatio * 100)}% of detected suppliers are confirmed — review the remaining candidates.`);
  }
  if (inputs.posItemsMappedRatioByVolume !== null && !steps.posItemsMapped.done) {
    blockers.push(`Only ${Math.round(inputs.posItemsMappedRatioByVolume * 100)}% of sales revenue comes from mapped POS items — map the highest-volume unmapped items.`);
  }
  if (recipesRatio !== null && !steps.recipesCreated.done) {
    blockers.push(
      `${inputs.recipesCreated.withRecipe} of your top ${inputs.recipesCreated.topMenuItemCount} menu items have a recipe — add recipes for the rest to see real margin.`
    );
  }
  if (parLevelsRatio !== null && !steps.parLevelsSet.done) {
    blockers.push(
      `${inputs.parLevelsSet.fullyCovered} of ${inputs.parLevelsSet.recipeCoveredMenuItemCount} recipe-covered top menu items have par levels set on every ingredient.`
    );
  }

  // A brand-new org with no onboarding_progress row yet hasn't started, which is a different real
  // state from "started, then went quiet" — only the latter is actionable "stalled" outreach (I7:
  // "no activity recorded" and "stalled after activity" are genuinely different facts).
  const stalled =
    inputs.onboardingProgressUpdatedAt !== null &&
    score < 100 &&
    daysBetween(inputs.onboardingProgressUpdatedAt, inputs.now) >= STALLED_AFTER_DAYS;

  return { score, steps, blockers, stalled };
};
