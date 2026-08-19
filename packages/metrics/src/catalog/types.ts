import type { z } from 'zod';
import type { Redis } from 'ioredis';
import type { createDb } from '@retailos/db';
import type { Permission } from '@retailos/authz';

type Db = ReturnType<typeof createDb>['db'];

/**
 * The unit a metric's VALUE is expressed in — distinct from `@retailos/domain`'s `Unit`, which is
 * a physical measurement unit (kg, ml, each) used for product quantities. A metric never returns a
 * physical quantity directly; it returns a currency amount, a percentage, a plain count, or a
 * ratio. Named `MetricUnit` specifically to avoid colliding with the domain package's `Unit` import
 * at any call site that needs both.
 */
export type MetricUnit = 'CURRENCY' | 'PERCENTAGE' | 'COUNT' | 'RATIO' | 'DAYS';

/**
 * A store-scoped date range. Callers pass calendar-intent boundaries; period resolution into
 * store-local time is earlier work's fact-table job, not built yet — every metric
 * registered in this task takes `from`/`to` as already-resolved UTC instants, matching the
 * dashboard router's own current behaviour. Do not treat this as timezone-correct; it is a known,
 * explicit gap (see `packages/metrics/src/catalog/README` note in this file's header) until the
 * fact-table phase lands.
 */
export type DateRange = { from: Date; to: Date };

/**
 * The minimal execution context a metric needs: which tenant, which stores, and a DB handle to
 * read from. Deliberately NOT `@retailos/authz`'s full `AuthContext` — permission enforcement is
 * the CALLER's job (a tRPC router checks `requiredPermission` before invoking the catalog, exactly
 * as every existing router already gates its own procedures), so this package takes no dependency
 * on session/role machinery. `storeIds` mirrors `AuthContext.storeIds`'s own shape (`'ALL'` or an
 * explicit array) so a caller can pass its session's access scope straight through without
 * translating it.
 */
export type MetricContext = {
  db: Db;
  organizationId: string;
  storeIds: string[] | 'ALL';
  /**
   * Optional cache client. When present, `executeMetric` serves a cache hit and
   * single-flights a miss instead of calling `execute` directly. Omitted entirely, this context
   * behaves exactly as it always has — a plain live query every call, matching every existing
   * caller (test files, any consumer not yet updated to pass a Redis client).
   */
  cache?: Redis;
};

/** One source table (or fact table, once earlier work exists) a metric reads — powers provenance. */
export type MetricSource = string;

export type MetricProvenance = {
  table: MetricSource;
  rowCount: number;
};

/**
 * The result shape every metric returns, matching the design's `MetricResult` and the design's
 * "every metric returns value, unit, period, computedAt, freshness, provenance" acceptance
 * criterion. `value` is `'unknown'` rather than `0`/`null` when the underlying computation cannot
 * produce a real number (I7) — never coerced away by a caller.
 */
export type MetricResult = {
  metricId: string;
  value: string | 'unknown';
  unit: MetricUnit;
  period: DateRange;
  computedAt: Date;
  /** As-of time of the underlying data this result was computed from. Equals `computedAt` for a
   * live query (every metric registered so far); will diverge once earlier work's fact tables introduce
   * incremental lag. */
  freshness: Date;
  provenance: MetricProvenance[];
  /** Present only for `'unknown'` results — WHY it's unknown, not just that it is. */
  unknownReason?: string;
};

/**
 * The registered definition of one metric. `execute` is the ONLY place this metric's value is
 * computed — a dashboard, a REST endpoint, and (once a later milestone exists) the AI assistant all call the
 * same function through `executeMetric`, which is what makes their results identical by
 * construction rather than by convention (I2).
 */
export type MetricDefinition<TParams> = {
  id: string;
  /** Used for AI-router matching once a later milestone exists — written in the words a user would say. */
  description: string;
  parameters: z.ZodType<TParams>;
  unit: MetricUnit;
  /** The permission a caller must hold to invoke this metric. Enforced by the caller, not here —
   * see `MetricContext`'s own note. Declared on the definition so a future AI tool-list can inherit
   * it directly from the catalog rather than maintaining a parallel permission map. */
  requiredPermission: Permission;
  /** Tables (or fact tables, later) this metric reads — becomes `MetricResult.provenance`. */
  sources: readonly MetricSource[];
  execute(params: TParams, ctx: MetricContext): Promise<MetricResult>;
};
