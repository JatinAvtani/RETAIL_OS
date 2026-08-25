import { z } from 'zod';
import { getMetric } from '@retailos/metrics';
import { delimitUntrustedText, UNTRUSTED_DATA_INSTRUCTION, type ChatProvider } from '@retailos/ai';
import { buildMetricToolSurface, type MetricToolDefinition } from './tool-surface';
import { applyDefaultStore, type AccessibleProduct, type AccessibleStore } from './resolve-store-params';
import type { RejectedSelection, ValidatedSelection } from './selection';

// Re-exported so existing importers of these types from './planning' keep working; they are
// DECLARED in './selection' so planning and resolve-store-params do not form an import cycle.
export type { RejectedSelection, ValidatedSelection };

/**
 * "PLAN (LLM with tool definitions = the metric catalog) → selects metric IDs + parameters →
 * parameters validated against Zod schemas → invalid/nonexistent metric IDs rejected before
 * execution."
 *
 * Reuses `ChatProvider.generateStructured` rather than adding a second, native function-calling
 * mechanism to `ChatProvider` — the available tools are described as text inside the prompt (from
 * `buildMetricToolSurface`), and the model returns a plain JSON object matching
 * `PLAN_RESPONSE_SCHEMA`. One structured-output mechanism for the whole assistant, not two.
 *
 * A question can genuinely need more than one metric ("why did my food cost go up" plausibly
 * needs `food_cost_percentage` AND `cost_variance`), so the response is a LIST of selections, not
 * a single metric id — matching real Gemini function-calling's own `functionCalls` being an
 * array, even though this deliberately doesn't use that native mechanism.
 *
 * **`params` is a JSON-ENCODED STRING, not a nested object field — confirmed via a real live
 * call, not assumed.** A first draft declared `params` as `{ type: 'object' }` (untyped, since
 * each metric's own parameter shape genuinely differs and the response schema is fixed for every
 * question regardless of which metrics get selected). Against the real Gemini API, that
 * consistently came back as a genuinely EMPTY `{}` — not malformed, just never populated —
 * across every metric and prompt wording tried (including an explicit "params must contain every
 * key, never empty" instruction and an `additionalProperties: true` schema hint, neither helped).
 * Gemini's structured-output mode does not reliably populate an untyped nested `object` field
 * inside an array item. Switching `params` to a plain `paramsJson: string` field (the model
 * writes a JSON-encoded object as a string, parsed back out afterward) fixed it immediately and
 * consistently, confirmed via a real live call. This is a genuine Gemini API limitation, not a
 * prompt-engineering problem this project's own prompt wording could have solved.
 */
const PLAN_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    selections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          metricId: { type: 'string', description: 'Must be exactly one of the tool names listed above.' },
          paramsJson: {
            type: 'string',
            description: 'A JSON-encoded object string containing every parameter this metric\'s own schema requires, with real extracted values — e.g. "{\\"storeId\\":\\"...\\",\\"from\\":\\"2026-08-01\\",\\"to\\":\\"2026-08-31\\"}". Never an empty object string.',
          },
        },
        required: ['metricId', 'paramsJson'],
      },
    },
  },
  required: ['selections'],
};

const rawPlanSchema = z.object({
  selections: z.array(
    z.object({
      metricId: z.string(),
      paramsJson: z.string(),
    })
  ),
});

export type PlanResult = {
  /** Selections that passed BOTH checks: the metric id exists in the catalog, AND its own params parsed against the metric's real Zod schema. Only these are safe to hand to execution. */
  selections: ValidatedSelection[];
  /** Every selection the model proposed that failed validation, with why — never silently dropped, so a future refusal path or eval log can explain exactly what went wrong instead of a bundle that's silently missing a metric. */
  rejected: RejectedSelection[];
  /** Set only when planning could not be attempted at all (provider error, malformed response) — distinct from a well-formed plan that simply proposed zero selections. */
  error: string | null;
};

const describeTool = (tool: MetricToolDefinition): string =>
  `- ${tool.name}: ${tool.description}\n  parameters: ${JSON.stringify(tool.parametersSchema)}`;

const describeStore = (store: AccessibleStore): string => `- ${store.id}: ${store.name}`;

const describeProduct = (p: AccessibleProduct): string => `- ${p.name}: productId=${p.id} variantId=${p.variantId}`;

const buildPrompt = (question: string, tools: MetricToolDefinition[], accessibleStores: AccessibleStore[], today: Date, products: AccessibleProduct[]): string =>
  `You are planning how to answer a business question by selecting metric functions to call. You do NOT compute any number yourself — you only choose which metric(s) to call and with what parameters. A question may need one metric or several.

Available metrics:
${tools.map(describeTool).join('\n')}

Stores this user can access (use these EXACT ids for any storeId parameter):
${accessibleStores.length > 0 ? accessibleStores.map(describeStore).join('\n') : '- (none)'}

Today's date is ${today.toISOString().slice(0, 10)}. Resolve every relative period against it: "the last 7 days" ends today, "last month" is the calendar month before this one.

${
  products.length > 0
    ? `Products, for any metric needing productId and variantId (use these EXACT ids):\n${products.map(describeProduct).join('\n')}`
    : 'No product list is available, so do not select a metric that requires a productId.'
}

Rules:
- Only select metricId values from the list above. Never invent one.
- Provide every parameter each selected metric's own schema requires.
- A storeId MUST be copied exactly from the store list above. Never invent, guess, or construct a storeId — if the question names a store, use that store's id; if it names none and there is exactly one store, use it.
- A productId and variantId MUST likewise be copied exactly from the product list above, as a matching pair from the SAME line. If the question names no product and a metric requires one, do not select that metric — prefer a store-wide metric if one fits, otherwise select nothing.
- Date parameters MUST be resolved against today's date given above. Never guess a year or month from memory.
- If the question genuinely doesn't need any of these metrics, return an empty selections array — do not force a selection that doesn't fit.
- ${UNTRUSTED_DATA_INSTRUCTION}

Return only the structured JSON matching the schema.

${delimitUntrustedText('question', question)}`;

/**
 * Validates each proposed selection against the REAL catalog — never trusts the model's own
 * claim that a metricId exists, that `paramsJson` is even valid JSON, or that the decoded params
 * are well-formed (the same "never trust the model past its own schema" discipline every
 * classification/extraction function in this codebase already follows). `getMetric` and
 * each metric's own `parameters.safeParse` are the single source of truth here, matching I2: this
 * function makes no judgment about whether a metric SHOULD apply to the question, only whether
 * what the model proposed is real.
 */
const validateSelections = (
  proposed: { metricId: string; paramsJson: string }[],
  accessibleStores: AccessibleStore[]
): { selections: ValidatedSelection[]; rejected: RejectedSelection[] } => {
  const selections: ValidatedSelection[] = [];
  const rejected: RejectedSelection[] = [];

  for (const { metricId, paramsJson } of proposed) {
    const definition = getMetric(metricId);
    if (!definition) {
      rejected.push({ metricId, reason: `'${metricId}' is not a registered metric.` });
      continue;
    }

    let params: unknown;
    try {
      params = JSON.parse(paramsJson);
    } catch (e) {
      rejected.push({ metricId, reason: `paramsJson was not valid JSON: ${(e as Error).message}` });
      continue;
    }

    // Fill an omitted storeId ONLY when there is exactly one accessible store, before the metric's
    // own schema sees the params — `storeId` is required with no default, so defaulting after
    // `safeParse` would be unreachable. With several stores this is a no-op and the selection is
    // reported as a real gap, which is how the caller gets asked which store they meant.
    const withDefaults =
      params !== null && typeof params === 'object' && !Array.isArray(params)
        ? applyDefaultStore(params as Record<string, unknown>, accessibleStores)
        : params;

    const parsed = definition.parameters.safeParse(withDefaults);
    if (!parsed.success) {
      rejected.push({ metricId, reason: `parameters did not match the metric's own schema: ${parsed.error.message}` });
      continue;
    }

    selections.push({ metricId, params: parsed.data as Record<string, unknown> });
  }

  return { selections, rejected };
};

export const planMetricSelections = async (
  provider: ChatProvider,
  question: string,
  model: string,
  accessibleStores: AccessibleStore[],
  // Injected rather than read from the clock inside `buildPrompt` so a test can pin it. The model
  // has no idea what day it is: without this, "the last 7 days" resolved to a window six months
  // stale, which then reported a real 0.00 over a period with no rows — the same I7 failure the
  // storeId check closes, reached through the dates instead of the store.
  today: Date = new Date(),
  products: AccessibleProduct[] = []
): Promise<PlanResult> => {
  const tools = buildMetricToolSurface();
  const result = await provider.generateStructured(buildPrompt(question, tools, accessibleStores, today, products), model, PLAN_RESPONSE_SCHEMA);

  if (result.error) {
    return { selections: [], rejected: [], error: result.error };
  }

  const parsed = rawPlanSchema.safeParse(result.data);
  if (!parsed.success) {
    return { selections: [], rejected: [], error: `response did not match the expected plan shape: ${parsed.error.message}` };
  }

  const { selections, rejected } = validateSelections(parsed.data.selections, accessibleStores);
  return { selections, rejected, error: null };
};
