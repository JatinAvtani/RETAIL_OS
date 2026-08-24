/**
 * Deletes one organization and everything under it, in an FK-safe order DERIVED AT RUNTIME from
 * `pg_constraint` rather than hand-written.
 *
 * Why derived, not a hardcoded list: this repo has been bitten by teardown ordering repeatedly, and
 * a hand-maintained list silently rots the moment anyone adds a table. Reading the live catalogue
 * means the order is correct by construction, including for tables that did not exist when this was
 * written.
 *
 * Two structural facts the catalogue reveals, neither of which is guessable:
 *
 *  1. A GENUINE MUTUAL FK CYCLE between `lots` and `goods_receipt_lines` — a lot points at the
 *     receipt line that created it (`lots.goods_receipt_line_id`) and the line points back at the
 *     lot it produced (`goods_receipt_lines.lot_id`). NO delete order can satisfy both constraints,
 *     so the cycle is broken first by nulling one side. Both columns are nullable, which is what
 *     makes this legal; the code asserts that rather than assuming it.
 *
 *  2. Several tables have NO `organization_id` of their own — `product_variants`, `recipe_components`,
 *     `supplier_prices`, `document_email_intake_attachments`. An org-scoped `DELETE ... WHERE
 *     organization_id = $1` skips them entirely and leaves orphans that then block their parents.
 *     Each is deleted via a subquery through its owning parent instead.
 *
 * Usage (standalone):
 *   DATABASE_URL=... tsx src/scripts/wipe-organization.mts <organizationId> [--dry-run]
 */
import type { createDb } from '@retailos/db';
import { sql } from 'drizzle-orm';

/**
 * The concrete database handle, inferred from `createDb` rather than named as a driver type — this
 * project uses postgres-js, and hardcoding `NodePgDatabase` here typechecks against the wrong
 * driver. Inferring keeps it correct if the driver ever changes.
 */
type Db = ReturnType<typeof createDb>['db'];
/** A transaction handle exposes the same `execute` this module needs, so both are accepted. */
type Executor = Pick<Db, 'execute'>;

/**
 * Tables without their own `organization_id`, and the scoping predicate that reaches them through a
 * parent that does have one. Anything not listed here is assumed org-scoped and is verified as such
 * before use — an unlisted, unscoped table raises rather than being silently skipped.
 */
const ORPHAN_SCOPES: Record<string, string> = {
  product_variants: 'product_id IN (SELECT id FROM products WHERE organization_id = $1)',
  recipe_components: 'recipe_id IN (SELECT id FROM recipes WHERE organization_id = $1)',
  supplier_prices:
    'supplier_product_id IN (SELECT id FROM supplier_products WHERE organization_id = $1)',
  document_email_intake_attachments:
    'intake_id IN (SELECT id FROM document_email_intake WHERE organization_id = $1)',
};

/**
 * Never touched by a tenant wipe. `units` and `unit_conversions` are reference data shared by every
 * organization; `users` and `verification_tokens` outlive any single tenant (the demo user must
 * survive a re-seed, since the login is what the demo depends on).
 */
const GLOBAL_TABLES = new Set(['units', 'unit_conversions', 'users', 'verification_tokens', 'organizations']);

interface WipePlanStep {
  table: string;
  predicate: string;
}

export interface WipeResult {
  /** Ordered steps that were (or would be) executed. */
  plan: WipePlanStep[];
  /** Rows actually deleted per table. Empty when `dryRun`. */
  deleted: Record<string, number>;
  dryRun: boolean;
}

/** Strips a partition suffix so partitions collapse onto their parent table. */
const basename = (table: string): string =>
  table.replace(/_(\d{4}_\d{2}|default)$/, '');

/**
 * Builds the delete order by topologically sorting the live FK graph: a table is only safe to delete
 * once every table that references it has already gone.
 */
/**
 * The one FK edge the wipe breaks by hand before deleting (see the cycle note at the top of this
 * file). It is excluded from the ordering graph because by the time the delete loop runs, the column
 * has already been nulled and the edge no longer constrains anything. Excluding it is what lets the
 * remaining graph sort at all.
 */
const CYCLE_BREAKING_EDGE = { child: 'lots', parent: 'goods_receipt_lines' } as const;

const deriveOrder = (edges: { child: string; parent: string }[], tables: string[]): string[] => {
  const nodes = new Set(tables);
  const dependents = new Map<string, Set<string>>();
  for (const { child, parent } of edges) {
    if (child === parent || !nodes.has(child) || !nodes.has(parent)) continue;
    if (child === CYCLE_BREAKING_EDGE.child && parent === CYCLE_BREAKING_EDGE.parent) continue;
    const set = dependents.get(parent) ?? new Set<string>();
    set.add(child);
    dependents.set(parent, set);
  }

  const order: string[] = [];
  const remaining = new Set(nodes);
  while (remaining.size > 0) {
    const free = [...remaining]
      .filter((n) => {
        const deps = dependents.get(n);
        if (!deps) return true;
        return ![...deps].some((d) => remaining.has(d));
      })
      .sort();
    if (free.length === 0) {
      // Any surviving knot is a real cycle the caller has not broken. Naming the tables matters —
      // a bare "cycle detected" would leave the next person doing this exact catalogue query again.
      throw new Error(
        `Unbroken FK cycle among: ${[...remaining].sort().join(', ')}. ` +
          'Add a cycle-breaking UPDATE before the delete loop.'
      );
    }
    order.push(...free);
    for (const n of free) remaining.delete(n);
  }
  return order;
};

export const wipeOrganization = async (
  db: Executor,
  organizationId: string,
  options: { dryRun?: boolean } = {}
): Promise<WipeResult> => {
  const dryRun = options.dryRun ?? false;

  /* ---- read the live catalogue ---- */
  const tableRows = await db.execute<{ table_name: string; has_org: boolean }>(sql`
    SELECT c.relname AS table_name,
           EXISTS (SELECT 1 FROM information_schema.columns col
                   WHERE col.table_schema = 'public'
                     AND col.table_name = c.relname
                     AND col.column_name = 'organization_id') AS has_org
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  `);

  const edgeRows = await db.execute<{ child: string; parent: string }>(sql`
    SELECT src.relname AS child, tgt.relname AS parent
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = src.relnamespace
    WHERE con.contype = 'f' AND n.nspname = 'public'
  `);

  /* ---- collapse partitions, drop global tables ---- */
  const hasOrg = new Map<string, boolean>();
  for (const row of tableRows) {
    const name = basename(row.table_name);
    // A partition and its parent share a name after collapsing; either having the column is enough.
    hasOrg.set(name, (hasOrg.get(name) ?? false) || row.has_org);
  }
  const candidates = [...hasOrg.keys()].filter((t) => !GLOBAL_TABLES.has(t));

  const edges = edgeRows.map((r) => ({ child: basename(r.child), parent: basename(r.parent) }));

  /* ---- every candidate must be reachable: org-scoped, or explicitly mapped ---- */
  const unreachable = candidates.filter((t) => !hasOrg.get(t) && !(t in ORPHAN_SCOPES));
  if (unreachable.length > 0) {
    // Failing loudly beats silently leaving rows behind: an unreachable table is data that survives
    // the wipe and then blocks the next seed with a confusing FK error far from its cause.
    throw new Error(
      `Tables have no organization_id and no ORPHAN_SCOPES entry: ${unreachable.sort().join(', ')}. ` +
        'Add a scoping predicate for each before wiping.'
    );
  }

  const order = deriveOrder(edges, candidates);
  const plan: WipePlanStep[] = order.map((table) => ({
    table,
    predicate: hasOrg.get(table) ? 'organization_id = $1' : ORPHAN_SCOPES[table]!,
  }));

  if (dryRun) return { plan, deleted: {}, dryRun: true };

  const deleted: Record<string, number> = {};

  /**
   * Break the lots <-> goods_receipt_lines cycle before deleting anything. Nulling `lots.
   * goods_receipt_line_id` is the safer side: it is provenance ("which receipt line created this
   * lot"), and these rows are about to be deleted anyway. The columns' nullability is asserted
   * rather than assumed — if a migration ever makes either NOT NULL, this must fail loudly instead
   * of erroring deep inside the delete loop.
   */
  const nullable = await db.execute<{ table_name: string; is_nullable: string }>(sql`
    SELECT table_name, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public'
      AND ((table_name = 'lots' AND column_name = 'goods_receipt_line_id')
        OR (table_name = 'goods_receipt_lines' AND column_name = 'lot_id'))
  `);
  for (const row of nullable) {
    if (row.is_nullable !== 'YES') {
      throw new Error(
        `${row.table_name} cycle column is NOT NULL — the lots/goods_receipt_lines cycle can no ` +
          'longer be broken by nulling. Revisit wipe-organization.mts.'
      );
    }
  }
  await db.execute(
    sql`UPDATE lots SET goods_receipt_line_id = NULL WHERE organization_id = ${organizationId}`
  );

  for (const step of plan) {
    /**
     * The table name and predicate come from `pg_constraint` and a constant map in this file — never
     * from user input — so splicing them in is safe. The organization id is the one value that could
     * carry anything, so it stays a BOUND PARAMETER rather than being interpolated into the string.
     * `$1` in ORPHAN_SCOPES is rewritten to Drizzle's own placeholder by splitting around it.
     */
    const [before = '', after = ''] = step.predicate.split('$1');
    /**
     * `RETURNING 1` is what makes the count reliable. This driver returns rows from `db.execute`
     * rather than a pg `Result`, so `rowCount` is undefined and a naive `result.rowCount ?? 0`
     * silently reports every table as "0 deleted" — a wipe that looks like a no-op while actually
     * deleting everything is the worst possible feedback for a destructive operation.
     */
    const result = await db.execute(
      sql`DELETE FROM ${sql.raw(step.table)} WHERE ${sql.raw(before)}${organizationId}${sql.raw(after)} RETURNING 1`
    );
    deleted[step.table] = Array.isArray(result) ? result.length : (result as { rowCount?: number }).rowCount ?? 0;
  }

  return { plan, deleted, dryRun };
};

/**
 * Standalone entry. Guarded so importing this module for `wipeOrganization` does not also connect to
 * a database and delete something — importing a file must never have side effects.
 */
if (process.argv[1]?.endsWith('wipe-organization.mts')) {
  const { createDb } = await import('@retailos/db');
  const organizationId = process.argv[2];
  if (!organizationId) {
    console.error('Usage: tsx src/scripts/wipe-organization.mts <organizationId> [--dry-run]');
    process.exit(1);
  }
  const { db } = createDb(process.env.DATABASE_URL!);
  /**
   * `--rehearse` runs every real DELETE inside a transaction and then ROLLS BACK. A dry run only
   * proves the ordering sorts; a rehearsal proves each statement actually executes against the live
   * schema — catching a bad predicate or an unreachable table — without destroying anything.
   */
  const rehearse = process.argv.includes('--rehearse');
  let result: WipeResult;
  if (rehearse) {
    // Drizzle signals a rollback by THROWING, so the escape is expected control flow, not an error.
    // The counts are printed from inside the transaction, before the rollback discards them.
    let inner: WipeResult | undefined;
    try {
      await db.transaction(async (tx) => {
        inner = await wipeOrganization(tx, organizationId, {});
        tx.rollback();
      });
    } catch (err) {
      if (inner === undefined) throw err;
    }
    result = inner!;
    const nonZero = Object.entries(result.deleted).filter(([, n]) => n > 0);
    console.log(
      JSON.stringify(
        { rehearsal: true, rolledBack: true, tables: result.plan.length, deletedRows: Object.fromEntries(nonZero) },
        null,
        2
      )
    );
    process.exit(0);
  } else {
    result = await wipeOrganization(db, organizationId, {
      dryRun: process.argv.includes('--dry-run'),
    });
  }
  if (result.dryRun) {
    console.log(`DRY RUN — ${result.plan.length} tables, in this order:`);
    result.plan.forEach((s, i) => console.log(`${String(i + 1).padStart(3)} ${s.table.padEnd(38)} ${s.predicate}`));
  } else {
    const nonZero = Object.entries(result.deleted).filter(([, n]) => n > 0);
    console.log(JSON.stringify({ tables: result.plan.length, deletedRows: Object.fromEntries(nonZero) }, null, 2));
  }
  process.exit(0);
}
