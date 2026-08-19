import type { ChatProvider } from './chat-provider';
import { delimitUntrustedText, UNTRUSTED_DATA_INSTRUCTION } from './prompt-safety';

/**
 * "classify: LLM, cheap/fast model, METRIC | RETRIEVAL | HYBRID | ACTION_DRAFT | UNSUPPORTED."
 * Named `ACTION_DRAFT` (not the bare `ACTION` a first sketch might reach for) since an
 * action intent NEVER executes, only drafts, so the intent value itself should say that.
 *
 * This is pure text→intent classification — no role/permission awareness belongs here. Role-based
 * filtering happens at EXECUTE, not CLASSIFY: "Staff asking for margin → permission refusal, not
 * data" is a downstream concern once a metric is actually about to run under the caller's ctx, not
 * something the classifier itself decides.
 */
export const INTENT_TYPES = ['METRIC', 'RETRIEVAL', 'HYBRID', 'ACTION_DRAFT', 'UNSUPPORTED'] as const;

export type IntentType = (typeof INTENT_TYPES)[number];

export interface IntentClassificationResult {
  intent: IntentType;
  confidence: number;
  /** Set only when classification could not be attempted at all (provider error, timeout, malformed response) — distinct from a genuine low-confidence UNSUPPORTED classification. */
  error: string | null;
}

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...INTENT_TYPES] },
    confidence: { type: 'number', description: '0 to 1, your subjective confidence in this classification' },
  },
  required: ['intent', 'confidence'],
};

const PROMPT_PREFIX = `You are routing a question a restaurant/café owner or manager asked a business-operations assistant. Classify it into exactly one of these categories:

- METRIC: the question asks for a specific computable business number (a food cost %, revenue, margin, stock level, etc.) — something the metric catalog can compute directly.
- RETRIEVAL: the question asks for qualitative information found in documents, reviews, or entity descriptions (e.g. "find the contract with Nova Foods", "what are customers saying about the coffee?") — no number needs computing, a real document/passage needs finding.
- HYBRID: the question genuinely needs BOTH a computed number AND retrieved context to answer (e.g. "why did my food cost go up — check if any supplier prices changed").
- ACTION_DRAFT: the question asks the assistant to DO something in the business (e.g. "order more flour", "create a purchase order for X") — this NEVER executes automatically, it only produces a draft for a human to review and approve.
- UNSUPPORTED: the question is outside what this assistant can do at all (unrelated to the business, or a capability that genuinely doesn't exist here, e.g. asking for a sales forecast when no forecasting capability exists).

If a question is ambiguous between two categories, choose the one requiring the LEAST assumption — do not guess a specific category you are not confident about; a lower-confidence UNSUPPORTED is safer than a confident wrong classification, since a wrong classification routes the question down entirely the wrong pipeline.

${UNTRUSTED_DATA_INSTRUCTION}

Return only the structured JSON matching the schema.

`;

/**
 * Real Gemini call via the shared `ChatProvider` abstraction — no direct `@google/genai`
 * import here, matching `packages/ai`'s own "no provider SDK outside this package" rule extended
 * to its own internal callers too. `model` is the caller's responsibility to resolve via
 * `modelForTask('CLASSIFY')`, not hardcoded here — this function stays provider- and
 * model-agnostic, exactly what `ChatProvider` exists to make possible.
 *
 * The question is wrapped via `delimitUntrustedText` — a probabilistic,
 * secondary defense on top of this pipeline's real one (the metric catalog + the numeric grounding
 * validator downstream), not a substitute for it. See `prompt-safety.ts`'s own header comment for
 * why the question itself, not just future retrieved passages, is a real untrusted-text channel.
 */
export const classifyIntent = async (provider: ChatProvider, question: string, model: string): Promise<IntentClassificationResult> => {
  const result = await provider.generateStructured(PROMPT_PREFIX + delimitUntrustedText('question', question), model, INTENT_SCHEMA);

  if (result.error) {
    return { intent: 'UNSUPPORTED', confidence: 0, error: result.error };
  }

  const data = result.data;
  if (
    typeof data !== 'object' ||
    data === null ||
    !('intent' in data) ||
    !('confidence' in data) ||
    typeof (data as { confidence: unknown }).confidence !== 'number' ||
    !INTENT_TYPES.includes((data as { intent: IntentType }).intent)
  ) {
    return { intent: 'UNSUPPORTED', confidence: 0, error: 'response did not match the expected classification shape' };
  }

  const parsed = data as { intent: IntentType; confidence: number };
  return { intent: parsed.intent, confidence: parsed.confidence, error: null };
};
