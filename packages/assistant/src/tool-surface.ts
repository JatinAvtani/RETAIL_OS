import { z } from 'zod';
import { listMetricIds, getMetric } from '@retailos/metrics';

/**
 * "The tool surface is generated FROM the catalog, so a metric added to it is automatically
 * available and nothing else is." This is the mechanical enforcement of I2 at the planning
 * boundary — the planning model never sees a hand-maintained tool list that could drift from the
 * real catalog; it sees exactly what `listMetricIds()`/`getMetric()` (already built) report,
 * today.
 *
 * `parametersSchema` is a plain JSON-Schema object (matching `ChatProvider.generateStructured`'s
 * own schema shape — no `@google/genai`-specific `Type` enum here either), built from each
 * metric's real Zod `parameters` via `z.toJSONSchema`. **`z.coerce.date()` cannot be represented
 * in JSON Schema at all — confirmed directly, Zod 4 throws on it by default.** Every metric using
 * a `from`/`to` date-range param (the large majority of the catalog) would otherwise either crash
 * this function or, with `unrepresentable: 'any'`, silently emit an empty `{}` schema for those
 * fields — giving the model zero format guidance and risking it emitting an unparseable date
 * string that only fails much later, at execution's real Zod validation. Fixed with an `override`
 * hook that rewrites any Zod `date` field to `{ type: 'string', format: 'date' }` (real
 * tool-calling APIs universally expect ISO date strings — JSON itself has no date type) —
 * confirmed this override actually fires by testing it directly against a real metric's params
 * shape before relying on it here. This JSON Schema is a HINT to the model only; it is never
 * itself the source of truth for validation — the real Zod schema (with its real `z.coerce.date()`
 * coercion) still runs at the execution boundary, unchanged.
 */
const toJsonSchema = (schema: z.ZodType<unknown>): Record<string, unknown> =>
  z.toJSONSchema(schema, {
    unrepresentable: 'any',
    override: (ctx) => {
      const def = (ctx.zodSchema as { _zod?: { def?: { type?: string } } })._zod?.def;
      if (def?.type === 'date') {
        ctx.jsonSchema.type = 'string';
        ctx.jsonSchema.format = 'date';
      }
    },
  }) as Record<string, unknown>;

export type MetricToolDefinition = {
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
};

/**
 * Every registered metric, as a tool definition. Deliberately does NOT filter by permission —
 * per the pipeline's own ordering (CLASSIFY → PLAN → EXECUTE), permission enforcement happens
 * at EXECUTE (`executeMetric` already does this unconditionally), not at the tool-list
 * boundary; a model that plans a call to a metric the caller can't actually run gets a real
 * `MetricPermissionDeniedError` at execution, which is the designed refusal path ("Staff asking
 * about margin gets a permission refusal, not data"), not something the tool surface should
 * pre-filter and hide. A future change could add a permission-scoped variant if a real need for
 * it appears; none exists yet.
 */
export const buildMetricToolSurface = (): MetricToolDefinition[] =>
  listMetricIds().map((id) => {
    const definition = getMetric(id);
    if (!definition) {
      // listMetricIds() and getMetric() both read the same module-level registry synchronously —
      // this branch is unreachable in practice, but TypeScript can't see that guarantee across
      // the two calls, and throwing here (rather than silently skipping) surfaces a genuine
      // registry-consistency bug immediately instead of producing a tool list one entry short.
      throw new Error(`listMetricIds() reported '${id}' but getMetric('${id}') returned nothing — registry is inconsistent.`);
    }
    return {
      name: definition.id,
      description: definition.description,
      parametersSchema: toJsonSchema(definition.parameters as z.ZodType<unknown>),
    };
  });

/** One tool definition by id — used by the planning stage to validate a model-selected metric id exists before building the call, and by tests. */
export const getMetricToolDefinition = (id: string): MetricToolDefinition | undefined => {
  const definition = getMetric(id);
  if (!definition) return undefined;
  return {
    name: definition.id,
    description: definition.description,
    parametersSchema: toJsonSchema(definition.parameters as z.ZodType<unknown>),
  };
};
