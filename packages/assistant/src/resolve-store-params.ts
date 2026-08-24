import type { ValidatedSelection } from './selection';

/**
 * Closes an I7 violation reachable through the AI layer.
 *
 * Every store-scoped metric requires `storeId: z.string().uuid()` with no default, but the planner
 * was never given a single real store id: `storeId` appeared in `planning.ts` only as a
 * PLACEHOLDER inside an example string in a tool-parameter description, and nowhere at all in
 * `pipeline.ts` or `execute-selections.ts`. The model was shown the shape and never given a value,
 * so it had to invent one.
 *
 * An invented UUID is syntactically valid, so it passed `definition.parameters.safeParse` and
 * executed. `executeMetric` checks the caller's PERMISSION but never that the store exists or
 * belongs to them, and the repositories scope by `organizationId`, so the query simply matched zero
 * rows. A summing metric then reported that as a real number:
 *
 *     gross_revenue -> value: "0.0000", provenance: [{ sales_transactions, rowCount: 0 }]
 *
 * A confident zero, indistinguishable from a store that genuinely sold nothing — and the grounding
 * validator cannot catch it, because a metric value is precisely what its allowlist permits. Only
 * ratio metrics degraded correctly, and only by accident (dividing by a zero count yields
 * `unknown`). Sums fabricated zeros.
 *
 * The fix is two-sided and BOTH halves are load-bearing:
 *
 *   1. `buildPrompt` now lists the caller's real accessible stores, so the model selects a genuine
 *      id instead of inventing one. This makes the assistant work.
 *   2. This module rejects any `storeId` the caller cannot actually access, BEFORE execution. This
 *      makes it correct, and does not depend on the model behaving.
 *
 * Half 2 alone would reject everything; half 1 alone would still let a misbehaving model fabricate.
 *
 * Resolution policy, when a selection omits `storeId` entirely: fill it in ONLY when the caller has
 * exactly one accessible store, where there is no ambiguity to resolve. With several, the selection
 * is rejected with a reason naming the real stores, so the caller is asked which one they meant
 * rather than having one silently picked for them. Aggregating across stores is deliberately NOT
 * done here — sums combine cleanly but percentages and ratios do not, and inventing an aggregation
 * rule per metric is exactly the kind of silent wrongness this module exists to prevent.
 */

export type AccessibleStore = {
  id: string;
  name: string;
};

export type StoreResolution = {
  /** Selections whose `storeId` is real, accessible, and now explicitly present. Safe to execute. */
  resolved: ValidatedSelection[];
  /** Selections that could not be tied to a real accessible store. Never executed; each carries a
   * reason that flows into the existing `invalid_selection` refusal category. */
  rejected: { metricId: string; reason: string }[];
};

/** Mirrors each metric's own `storeId` param name. A metric with no `storeId` is org-scoped and passes through untouched. */
const STORE_PARAM = 'storeId';

const nameList = (stores: AccessibleStore[]): string => stores.map((s) => s.name).join(', ');

export const resolveStoreParams = (
  selections: ValidatedSelection[],
  accessibleStores: AccessibleStore[]
): StoreResolution => {
  const resolved: ValidatedSelection[] = [];
  const rejected: { metricId: string; reason: string }[] = [];

  const byId = new Map(accessibleStores.map((s) => [s.id, s]));

  for (const selection of selections) {
    const raw = selection.params[STORE_PARAM];

    // Org-scoped metric — nothing to resolve.
    if (raw === undefined) {
      resolved.push(selection);
      continue;
    }

    if (typeof raw !== 'string') {
      rejected.push({ metricId: selection.metricId, reason: `'${STORE_PARAM}' was not a string.` });
      continue;
    }

    if (byId.has(raw)) {
      resolved.push(selection);
      continue;
    }

    // A real id the caller cannot see and a wholly invented one are reported identically — never
    // leaking whether some other tenant's store happens to exist, matching the cross-tenant
    // convention every id-scoped lookup in this codebase already follows.
    if (accessibleStores.length === 0) {
      rejected.push({ metricId: selection.metricId, reason: 'No store is available to this account, so this cannot be computed for any store.' });
      continue;
    }

    rejected.push({
      metricId: selection.metricId,
      reason: `'${raw}' is not a store this account can access. Ask again naming one of: ${nameList(accessibleStores)}.`,
    });
  }

  return { resolved, rejected };
};

/**
 * Fills in an omitted `storeId` for the unambiguous single-store case only.
 *
 * This MUST run before the metric's own `parameters.safeParse`, not after: `storeId` is required
 * with no default, so a selection that omits it fails validation outright and never becomes a
 * `ValidatedSelection` at all. Defaulting afterwards would be unreachable code.
 *
 * With several accessible stores this deliberately does nothing — the selection then fails
 * validation and is reported as a real gap, which is how the caller gets asked which store they
 * meant instead of having one silently chosen.
 */
export const applyDefaultStore = (
  params: Record<string, unknown>,
  accessibleStores: AccessibleStore[]
): Record<string, unknown> => {
  if (accessibleStores.length !== 1 || params[STORE_PARAM] !== undefined) {
    return params;
  }
  return { ...params, [STORE_PARAM]: accessibleStores[0]!.id };
};
