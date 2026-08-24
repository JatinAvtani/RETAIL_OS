/**
 * The shared vocabulary of a planned metric call, in its own leaf module.
 *
 * `ValidatedSelection` was originally declared in `planning.ts`, which was fine while planning was
 * the only producer and `execute-selections.ts` the only consumer. Adding `resolve-store-params.ts`
 * — which both consumes selections and feeds a helper back INTO planning — made that a genuine
 * import cycle, caught by `dependency-cruiser`'s `no-circular` rule.
 *
 * A passing `tsc` is not evidence a cycle is safe: type-only edges erase at runtime, so the
 * compiler stays quiet while the module graph is genuinely circular. The boundaries tool answers
 * the different, authoritative question. Hoisting the shared type to a module that imports nothing
 * breaks the cycle at its source rather than suppressing the rule.
 */

/** A metric call whose id exists in the real catalog AND whose params parsed against that metric's own Zod schema. Only these are safe to hand to execution. */
export type ValidatedSelection = {
  metricId: string;
  params: Record<string, unknown>;
};

/** A proposed selection that failed validation, with why — never silently dropped, so a refusal path or eval log can explain exactly what went wrong. */
export type RejectedSelection = {
  metricId: string;
  reason: string;
};
