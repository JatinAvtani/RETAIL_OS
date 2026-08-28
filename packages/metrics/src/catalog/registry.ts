import { hasPermission, type AuthContext } from '@retailos/authz';
import { withMetricCache } from './cache.js';
import type { MetricContext, MetricDefinition, MetricResult } from './types.js';

/**
 * The single registry every `defineMetric` call registers into. Module-level state, matching this
 * repo's precedent for other process-wide catalogs (`packages/queue`'s job registrations) — it is
 * populated once at import time and never mutated per-request, so there is no cross-tenant
 * collision surface despite being a singleton.
 */
const registry = new Map<string, MetricDefinition<unknown>>();

export class DuplicateMetricIdError extends Error {
  constructor(id: string) {
    super(`A metric with id '${id}' is already registered. Metric ids must be unique.`);
    this.name = 'DuplicateMetricIdError';
  }
}

export class UnknownMetricError extends Error {
  constructor(id: string) {
    super(`No metric is registered with id '${id}'.`);
    this.name = 'UnknownMetricError';
  }
}

export class MetricPermissionDeniedError extends Error {
  constructor(id: string, permission: string) {
    super(`Caller lacks '${permission}', required to compute metric '${id}'.`);
    this.name = 'MetricPermissionDeniedError';
  }
}

/**
 * Registers a metric definition. Validates the shape the acceptance criteria depend on — a
 * unique id, a declared permission, at least one source, a unit — at REGISTRATION time (import
 * time, in practice), so a malformed metric fails fast at process startup rather than surfacing as
 * a confusing runtime error the first time someone calls it.
 */
export const defineMetric = <TParams>(definition: MetricDefinition<TParams>): MetricDefinition<TParams> => {
  if (registry.has(definition.id)) {
    throw new DuplicateMetricIdError(definition.id);
  }
  if (!definition.requiredPermission) {
    throw new Error(`Metric '${definition.id}' must declare a requiredPermission.`);
  }
  if (definition.sources.length === 0) {
    throw new Error(`Metric '${definition.id}' must declare at least one source.`);
  }
  if (!definition.unit) {
    throw new Error(`Metric '${definition.id}' must declare a unit.`);
  }
  registry.set(definition.id, definition as MetricDefinition<unknown>);
  return definition;
};

export const getMetric = (id: string): MetricDefinition<unknown> | undefined => registry.get(id);

/** All registered metric ids — the catalog's own table of contents, e.g. for a future AI tool list. */
export const listMetricIds = (): string[] => [...registry.keys()];

/** Test-only: clears the module-level registry so each test file starts from a clean catalog. */
export const _resetRegistryForTests = (): void => {
  registry.clear();
};

/**
 * The ONE path through which any metric is ever computed (I2, I1's counterpart for numbers rather
 * than text). A dashboard, a REST endpoint, and any future AI tool call all resolve to this same
 * function, which is what makes their results identical by construction — there is no second way
 * to get a metric's value.
 *
 * Permission enforcement is checked HERE, not left to each individual metric's `execute`: a metric
 * author cannot forget to gate their own function, because the gate is unconditional and happens
 * before `execute` is ever called. `auth` is `AuthContext`, not `MetricContext`, deliberately — the
 * caller must prove who they are to get past this check; `MetricContext` alone (just an org id and
 * store scope) is not sufficient to authorize anything.
 */
export const executeMetric = async <TParams>(
  id: string,
  rawParams: unknown,
  auth: AuthContext,
  ctx: MetricContext
): Promise<MetricResult> => {
  const definition = getMetric(id) as MetricDefinition<TParams> | undefined;
  if (!definition) {
    throw new UnknownMetricError(id);
  }
  if (!hasPermission(auth, definition.requiredPermission)) {
    throw new MetricPermissionDeniedError(id, definition.requiredPermission);
  }
  const params = definition.parameters.parse(rawParams);

  if (ctx.cache) {
    return withMetricCache(ctx.cache, id, ctx.organizationId, ctx.storeIds, params, () => definition.execute(params, ctx));
  }
  return definition.execute(params, ctx);
};
