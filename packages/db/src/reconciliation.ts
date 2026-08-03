import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type DriftRow = {
  organizationId: string;
  storeId: string;
  productId: string;
  variantId: string;
  ledgerSum: string;
  projectionQuantity: string;
};

/**
 * ADR-03 / spec 08 §8.6: the ledger is truth, `stock_levels` is a cache maintained transactionally
 * alongside it (`StockLevelRepository.recordAndProject`, 005-03). That transactional discipline is
 * what SHOULD keep them equal at all times — this function is the mechanism that verifies it
 * actually holds, exactly per plan.md's Phase 3 query: any row it returns is a bug (a missed
 * projection update, a hand-edited row, a code path that bypassed `recordAndProject`), not a
 * data-quality nuance to explain away.
 *
 * Deliberately cross-tenant by nature — a reconciliation sweep is an internal correctness check,
 * not a request scoped to one organization's session, so it does NOT go through
 * `TenantScopedRepository` or `withTenantContext`. `db` must be an admin-equivalent connection that
 * can see every tenant's rows (RLS on `retailos_app` would otherwise scope this to whichever single
 * org happened to be set via `SET LOCAL`, silently hiding drift in every other tenant) — the same
 * category of deliberate, narrow RLS exception as the `SECURITY DEFINER` pre-tenant-context lookup
 * functions, but simpler here since this is an internal read with no write and no user-facing
 * caller. This module builds NO alerting/delivery mechanism (no notifications table, no scheduled
 * job) — it only detects and reports drift as data; a caller (a future worker job, an admin
 * endpoint) decides what to do with the result.
 *
 * `FULL OUTER JOIN`, not an inner join or a one-sided `LEFT JOIN` from either table alone: a plain
 * `stock_movements LEFT JOIN stock_levels` only ever produces rows for groups that exist in
 * `stock_movements`, so a `stock_levels` row with NO matching ledger rows at all (impossible via
 * `recordAndProject`, but not impossible via a hand-edited row, or a future bug that writes a
 * projection row through some other path) would be invisible to that query — exactly the kind of
 * drift this function exists to catch, silently missed. `FULL OUTER JOIN` plus grouping on
 * `COALESCE(m.organization_id, sl.organization_id)` (etc.) catches both directions: ledger rows
 * with no projection, and projection rows with no ledger.
 */
export const findStockLevelDrift = async (db: Db): Promise<DriftRow[]> => {
  const rows = await db.execute<{
    organization_id: string;
    store_id: string;
    product_id: string;
    variant_id: string;
    ledger_sum: string;
    projection_quantity: string;
  }>(sql`
    SELECT
      COALESCE(m.organization_id, sl.organization_id) AS organization_id,
      COALESCE(m.store_id, sl.store_id) AS store_id,
      COALESCE(m.product_id, sl.product_id) AS product_id,
      COALESCE(m.variant_id, sl.variant_id) AS variant_id,
      COALESCE(SUM(m.quantity), 0) AS ledger_sum,
      COALESCE(MAX(sl.quantity), 0) AS projection_quantity
    FROM stock_movements m
    FULL OUTER JOIN stock_levels sl
      ON sl.store_id = m.store_id
     AND sl.product_id = m.product_id
     AND sl.variant_id = m.variant_id
    GROUP BY
      COALESCE(m.organization_id, sl.organization_id),
      COALESCE(m.store_id, sl.store_id),
      COALESCE(m.product_id, sl.product_id),
      COALESCE(m.variant_id, sl.variant_id)
    HAVING COALESCE(SUM(m.quantity), 0) <> COALESCE(MAX(sl.quantity), 0)
  `);

  return rows.map((row) => ({
    organizationId: row.organization_id,
    storeId: row.store_id,
    productId: row.product_id,
    variantId: row.variant_id,
    ledgerSum: row.ledger_sum,
    projectionQuantity: row.projection_quantity,
  }));
};
