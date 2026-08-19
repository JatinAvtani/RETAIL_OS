import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { delimitUntrustedText, UNTRUSTED_DATA_INSTRUCTION, type ChatProvider } from '@retailos/ai';

/**
 * Spec 10 Phase 6: "'Order more flour' → produces a draft PO, executes nothing. The AI's
 * write access is exactly zero." An `ACTION_DRAFT`-classified question never reaches a repository
 * write directly (I9) — this function's only job is turning natural language into a VALIDATED,
 * structured line item a human-facing caller can later pass into the real, already-existing
 * `PurchaseOrderRepository.create`/`.addLine` after a human reviews and submits it.
 * Nothing in this file writes to a database or calls any repository.
 *
 * **Candidate resolution is deliberately narrow, settled deliberately before writing
 * any code**: there is no product-name search anywhere in this codebase (`ProductRepository` has
 * lookup-by-id only, no fuzzy or even exact-name matching — confirmed by reading the file, not
 * assumed). Building one would be a materially bigger, separate task (mirroring the POS-mapping feature's
 * `suggestMenuItemMatches`, itself a dedicated task). Instead, the CALLER supplies a real list of
 * `ActionCandidate`s it already fetched (e.g. from a future endpoint querying confirmed
 * supplier-products) — the model may only select a `candidateId` that exists in that exact list,
 * verbatim, the same "never trust the model past its own schema" discipline
 * `planMetricSelections`/`classifyIntent` already established. A model-invented id, or a real
 * product mentioned in the question that isn't in the supplied candidate list, is a rejection —
 * asking for clarification — never a guess.
 */
export type ActionCandidate = {
  /** An opaque id THIS function treats as a black box — the caller knows it maps to a real
   * productId/supplierId/supplierProductId triple; this module never needs to know that shape. */
  candidateId: string;
  /** The real product name a human would recognize, e.g. "All-purpose flour (25kg bag)". */
  label: string;
};

export type DraftActionLine = {
  candidateId: string;
  label: string;
  /** A real `Decimal`, never a raw `number` (I5) — but deliberately NOT yet a branded
   * `Quantity<Unit>`: that requires a real `Unit` value, and `unitLabel` below is free text the
   * model extracted with no real unit-conversion catalog to select from at draft time (the same
   * reason this codebase's own `ReorderExplanation.coverageDays` is a bare `Decimal`, not a
   * `Quantity`, when the underlying number is real but not yet unit-branded). The human reviewing
   * this draft confirms/corrects the real order unit before it becomes a real
   * `PurchaseOrderLine`, at which point I6's real conversion discipline applies exactly as it
   * already does for every other PO line in this codebase. */
  quantity: Decimal;
  /** The model's own free-text unit word, e.g. "bags", "kg" — NOT validated against a real Unit
   * conversion graph (I6) here. This is a draft for human review, not a computed quantity entering
   * the costing chain. */
  unitLabel: string;
};

export type ActionDraftResult = {
  /** Non-empty only when at least one line was both proposed by the model AND validated against
   * the real candidate list. A caller must treat an empty `lines` array as "could not draft
   * anything from this question" — never a silent success. */
  lines: DraftActionLine[];
  /** Every line the model proposed that referenced a candidateId not present in the supplied
   * list, or had a non-positive quantity — never silently dropped. */
  rejected: { candidateId: string; reason: string }[];
  /** Set only when the provider call itself failed or returned a malformed response — distinct
   * from a well-formed response that simply resolved to zero valid lines. */
  error: string | null;
};

const ACTION_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidateId: { type: 'string', description: 'Must be exactly one of the candidate ids listed above. Never invent one.' },
          quantity: { type: 'number', description: 'A positive quantity the caller asked to order.' },
          unitLabel: { type: 'string', description: 'The unit word the caller used or implied, e.g. "bags", "kg", "cases". If none was stated, use the most natural unit for this product.' },
        },
        required: ['candidateId', 'quantity', 'unitLabel'],
      },
    },
  },
  required: ['lines'],
};

const rawActionDraftSchema = z.object({
  lines: z.array(
    z.object({
      candidateId: z.string(),
      quantity: z.number(),
      unitLabel: z.string(),
    })
  ),
});

const describeCandidate = (c: ActionCandidate): string => `- ${c.candidateId}: ${c.label}`;

const buildPrompt = (question: string, candidates: ActionCandidate[]): string =>
  `You are drafting a purchase order line item from a business owner's request. You do NOT place any order and nothing you produce is submitted automatically — a human will review this draft before anything happens. You only select which real product(s) to draft a line for, and how much.

Real products available to order from (only these — never invent a product not in this list):
${candidates.length > 0 ? candidates.map(describeCandidate).join('\n') : 'None.'}

Rules:
- Only select candidateId values from the list above, copied exactly. Never invent one, even if the request clearly means a product that isn't listed — if nothing in the list matches, return an empty lines array instead of guessing the closest one.
- A request naming a product not on the list, or too vague to match confidently, should produce ZERO lines, not a best-effort guess.
- quantity must be a real positive number extracted from the request. If no quantity was stated, use a reasonable default of 1, never 0 or negative.
- ${UNTRUSTED_DATA_INSTRUCTION}

Return only the structured JSON matching the schema.

${delimitUntrustedText('request', question)}`;

/**
 * Validates every proposed line against the REAL, exact candidate list supplied by the caller —
 * never trusts the model's own claim that a `candidateId` was in that list, matching
 * `planMetricSelections`'s `validateSelections` precedent exactly. A candidate with a
 * non-positive quantity is also rejected here, not left for a downstream caller to discover —
 * `PurchaseOrderRepository.addLine` would compute a real `lineTotal` from this quantity, and a
 * zero/negative value would produce a nonsensical or negative money figure downstream (I5).
 */
const validateLines = (
  proposed: { candidateId: string; quantity: number; unitLabel: string }[],
  candidates: ActionCandidate[]
): { lines: DraftActionLine[]; rejected: { candidateId: string; reason: string }[] } => {
  const byId = new Map(candidates.map((c) => [c.candidateId, c]));
  const lines: DraftActionLine[] = [];
  const rejected: { candidateId: string; reason: string }[] = [];

  for (const { candidateId, quantity, unitLabel } of proposed) {
    const candidate = byId.get(candidateId);
    if (!candidate) {
      rejected.push({ candidateId, reason: `'${candidateId}' is not one of the supplied candidates.` });
      continue;
    }
    const decimalQuantity = new Decimal(quantity);
    if (!decimalQuantity.gt(0)) {
      rejected.push({ candidateId, reason: `quantity must be positive, got ${quantity}.` });
      continue;
    }
    lines.push({ candidateId, label: candidate.label, quantity: decimalQuantity, unitLabel });
  }

  return { lines, rejected };
};

export const planActionDraft = async (
  provider: ChatProvider,
  question: string,
  model: string,
  candidates: ActionCandidate[]
): Promise<ActionDraftResult> => {
  const result = await provider.generateStructured(buildPrompt(question, candidates), model, ACTION_DRAFT_SCHEMA);

  if (result.error) {
    return { lines: [], rejected: [], error: result.error };
  }

  const parsed = rawActionDraftSchema.safeParse(result.data);
  if (!parsed.success) {
    return { lines: [], rejected: [], error: `response did not match the expected action-draft shape: ${parsed.error.message}` };
  }

  const { lines, rejected } = validateLines(parsed.data.lines, candidates);
  return { lines, rejected, error: null };
};
