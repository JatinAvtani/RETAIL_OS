import type { ChatProvider } from '@retailos/ai';
import type { AuthContext } from '@retailos/authz';
import type { MetricContext } from '@retailos/metrics';
import type { SearchRepository } from '@retailos/db';
import { runPipeline, type PipelineOutcome } from './pipeline';
import { narrateAndValidate } from './validate-grounding';
import type { AccessibleProduct, AccessibleStore } from './resolve-store-params';
import type { GroundingBundle } from './grounding-bundle';
import type { ActionCandidate } from './action-draft';

/**
 * turns the single-shot `runPipeline` (one question → one bundle → one answer) into a
 * bounded multi-hop investigation — "why did margin drop in June" becomes a real chain (check
 * margin trend, see COGS spiked, check which items, check which supplier price changed) instead of
 * one metric call answering a question it cannot actually resolve alone.
 *
 * Every hop still runs the exact same `runPipeline` → `narrateAndValidate` sequence a single-shot
 * caller already trusts — I1/I9 are enforced identically per hop, not loosened for this loop. The
 * genuinely new piece is `priorSteps`: the ONLY context a later hop's plan is allowed to see is
 * EARLIER hops' own VALIDATED narration, never a raw `GroundingBundle`. Feeding raw metric values
 * back into a planning prompt would let the model treat an unvalidated intermediate number as
 * ground truth for deciding what to check next — validated text carries the same "already proven
 * grounded" guarantee at hop N that the single-shot pipeline only ever gave its FINAL answer.
 *
 * Termination is a real, typed outcome (`HOP_LIMIT_REACHED`), never a silent truncation or an
 * unbounded loop — `MAX_HOPS` is a hard cap, not a soft target the model can talk its way past.
 */
export const MAX_HOPS = 3;

export type InvestigationStep = {
  hop: number;
  /** The sub-question this hop's plan/execute stage actually ran against — hop 1 is the caller's
   * original question verbatim; later hops are the model's own follow-up framing. */
  question: string;
  /** This hop's own bundle — kept on the step so a UI can render per-hop citations, even though
   * only the VALIDATED narration (never this bundle) is what feeds the next hop's plan. */
  bundle: GroundingBundle;
  /** `null` only when this hop's narration failed to ground on both attempts, or the provider
   * itself errored — the same fail-closed contract `narrateAndValidate` already guarantees for a
   * single-shot answer, now enforced identically per hop. A `null` step still stops the loop
   * (see `runInvestigation`) rather than feeding an unvalidated bundle forward. */
  narration: string | null;
  sufficiency: 'SUFFICIENT' | 'NEEDS_FOLLOWUP' | 'HOP_LIMIT_REACHED' | 'GROUNDING_FAILED';
};

export type InvestigationOutcome =
  | { kind: 'investigation'; steps: InvestigationStep[]; finalBundle: GroundingBundle }
  | { kind: 'draft'; steps: InvestigationStep[]; draft: NonNullable<Extract<PipelineOutcome, { kind: 'draft' }>['draft']> }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'error'; reason: string };

const SUFFICIENCY_SCHEMA = {
  type: 'object',
  properties: {
    decision: {
      type: 'string',
      enum: ['SUFFICIENT', 'NEEDS_FOLLOWUP'],
      description:
        'SUFFICIENT if the investigation so far genuinely answers the original question. NEEDS_FOLLOWUP only if a real, specific follow-up fact would change or complete the answer.',
    },
    followUpQuestion: {
      type: 'string',
      description:
        'Required only when decision is NEEDS_FOLLOWUP. A single, specific, self-contained question — e.g. "which menu item drove the COGS increase in June" — never a restatement of the original question.',
    },
  },
  required: ['decision'],
};

/**
 * Classification only, never a place a number can be computed — matches `classifyIntent`'s own
 * shape exactly (structured output, closed answer set). This function must never see raw
 * `MetricResult` values, only the prior steps' already-validated prose, so there is nothing here
 * for a model to fabricate a figure FROM even if it tried.
 */
const buildSufficiencyPrompt = (originalQuestion: string, priorSteps: InvestigationStep[]): string => {
  const trail = priorSteps
    .map((s) => `Step ${s.hop} (asked: "${s.question}"): ${s.narration ?? '(no grounded answer was produced for this step)'}`)
    .join('\n\n');

  return `You are deciding whether an investigation into a business question is complete.

Original question: "${originalQuestion}"

Investigation so far:
${trail}

Decide: does the investigation so far genuinely answer the original question, or is there a real, specific follow-up that would meaningfully complete or change the answer? Only choose NEEDS_FOLLOWUP if you can name that exact follow-up question — never as a vague "check more data" request. If the prior steps already explain the root cause, or if further follow-ups would not plausibly be answerable from this system's own data, choose SUFFICIENT.

Return only the structured JSON matching the schema.`;
};

type SufficiencyDecision = { decision: 'SUFFICIENT' | 'NEEDS_FOLLOWUP'; followUpQuestion?: string };

const decideSufficiency = async (
  provider: ChatProvider,
  model: string,
  originalQuestion: string,
  priorSteps: InvestigationStep[]
): Promise<SufficiencyDecision> => {
  const result = await provider.generateStructured(
    buildSufficiencyPrompt(originalQuestion, priorSteps),
    model,
    SUFFICIENCY_SCHEMA
  );
  if (result.error || typeof result.data !== 'object' || result.data === null) {
    // A provider failure here must not crash the whole investigation — the safest default is to
    // stop and report what was found, the same "degrade to what's known" discipline (I7) the rest
    // of this pipeline already follows, never a silent infinite continuation.
    return { decision: 'SUFFICIENT' };
  }
  const data = result.data as Record<string, unknown>;
  if (data.decision === 'NEEDS_FOLLOWUP' && typeof data.followUpQuestion === 'string' && data.followUpQuestion.trim().length > 0) {
    return { decision: 'NEEDS_FOLLOWUP', followUpQuestion: data.followUpQuestion };
  }
  return { decision: 'SUFFICIENT' };
};

export type InvestigationContext = MetricContext & { searchRepository?: SearchRepository; geminiApiKey?: string };

/**
 * Runs one hop's real `runPipeline` call, then `narrateAndValidate` on the resulting bundle —
 * IDENTICAL to what a single-shot caller already does, so a hop's safety guarantees are never
 * weaker than the existing single-question path. Returns `null` when the hop resolves to something
 * other than a `bundle` outcome (a `draft`, `unsupported`, or `error`) — the caller decides how to
 * handle those, since they mean the investigation itself cannot continue as a metric-bundle chain.
 */
type NonBundleOutcome = Exclude<PipelineOutcome, { kind: 'bundle' }>;

const runHop = async (
  hopNumber: number,
  question: string,
  provider: ChatProvider,
  classifyModel: string,
  planModel: string,
  narrateModel: string,
  auth: AuthContext,
  ctx: InvestigationContext,
  accessibleStores: AccessibleStore[],
  products: AccessibleProduct[],
  actionCandidates: ActionCandidate[]
): Promise<{ step: InvestigationStep | null; nonBundleOutcome: NonBundleOutcome | null }> => {
  const outcome = await runPipeline(question, provider, classifyModel, planModel, auth, ctx, accessibleStores, products, actionCandidates);

  if (outcome.kind !== 'bundle') {
    return { step: null, nonBundleOutcome: outcome };
  }

  const narrated = await narrateAndValidate(provider, outcome.bundle, outcome.denied, outcome.failed, outcome.rejected, narrateModel);

  const step: InvestigationStep = {
    hop: hopNumber,
    question,
    bundle: outcome.bundle,
    narration: narrated.grounded ? narrated.text : null,
    // A hop whose narration failed to ground cannot safely inform a follow-up plan — GROUNDING_FAILED
    // is a real, distinct terminal state (see `runInvestigation`), never silently treated the same
    // as SUFFICIENT (which would claim the investigation succeeded) or continued into another hop
    // built on text that was never proven grounded.
    sufficiency: narrated.grounded ? 'NEEDS_FOLLOWUP' : 'GROUNDING_FAILED',
  };

  return { step, nonBundleOutcome: null };
};

/**
 * The bounded investigation loop itself. `ACTION_DRAFT`/`UNSUPPORTED`/`error` on the FIRST hop pass
 * straight through unchanged — an investigation only exists for questions that resolve to a real
 * metric bundle at all; drafting/refusal/error semantics are exactly `runPipeline`'s own and are
 * not re-implemented here. Those same outcomes on a LATER hop end the loop with what was already
 * found (see below) rather than discarding a real, already-validated earlier answer.
 */
export const runInvestigation = async (
  question: string,
  provider: ChatProvider,
  classifyModel: string,
  planModel: string,
  narrateModel: string,
  auth: AuthContext,
  ctx: InvestigationContext,
  accessibleStores: AccessibleStore[],
  products: AccessibleProduct[] = [],
  actionCandidates: ActionCandidate[] = [],
  maxHops: number = MAX_HOPS
): Promise<InvestigationOutcome> => {
  const steps: InvestigationStep[] = [];
  let currentQuestion = question;

  for (let hop = 1; hop <= maxHops; hop++) {
    const { step, nonBundleOutcome } = await runHop(
      hop,
      currentQuestion,
      provider,
      classifyModel,
      planModel,
      narrateModel,
      auth,
      ctx,
      accessibleStores,
      products,
      actionCandidates
    );

    if (nonBundleOutcome !== null) {
      if (hop === 1) {
        // Nothing to investigate yet — hand back the exact outcome a single-shot caller would get.
        if (nonBundleOutcome.kind === 'draft') return { kind: 'draft', steps: [], draft: nonBundleOutcome.draft };
        if (nonBundleOutcome.kind === 'unsupported') return { kind: 'unsupported', reason: nonBundleOutcome.reason };
        return { kind: 'error', reason: nonBundleOutcome.reason };
      }
      // A later hop resolving to something other than a bundle (e.g. the model's own follow-up
      // question drifted into ACTION_DRAFT/UNSUPPORTED territory) stops the loop honestly with
      // what earlier hops already proved, rather than discarding real, validated prior findings.
      break;
    }

    if (step === null) break; // unreachable given the branch above, but keeps the type honest
    steps.push(step);

    if (step.sufficiency === 'GROUNDING_FAILED') break;

    if (hop === maxHops) {
      steps[steps.length - 1] = { ...step, sufficiency: 'HOP_LIMIT_REACHED' };
      break;
    }

    const decision = await decideSufficiency(provider, classifyModel, question, steps);
    if (decision.decision === 'SUFFICIENT') {
      steps[steps.length - 1] = { ...step, sufficiency: 'SUFFICIENT' };
      break;
    }
    currentQuestion = decision.followUpQuestion as string;
  }

  const lastGroundedStep = [...steps].reverse().find((s) => s.narration !== null);
  const finalBundle: GroundingBundle = lastGroundedStep?.bundle ?? {
    metrics: [],
    metricScopes: [],
    passages: [],
    entities: [],
  };

  return { kind: 'investigation', steps, finalBundle };
};

export type { ActionCandidate };
