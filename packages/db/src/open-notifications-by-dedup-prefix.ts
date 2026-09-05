import { and, isNull, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index';
import { notifications } from './schema/index';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type OpenNotificationByDedupPrefix = {
  id: string;
  organizationId: string;
  dedupKey: string;
};

/**
 * The real cross-tenant read a SWEEP-based rule type (`lot_expiring`, `negative_stock`) needs to
 * resolve a notification whose underlying condition has cleared. An event-driven rule type
 * (`stock_below_reorder`) re-evaluates the SAME specific dedup key on every real event regardless
 * of outcome, so `resolveDedupAction`'s RESOLVE branch is naturally reached there. A sweep's
 * detection query (`findNegativeStock`/`findExpiryQueue`) only ever returns CURRENTLY-firing rows
 * — a row that recovered simply disappears from that result set, so nothing in the sweep's own
 * per-row/per-group loop would ever call `resolveDedupAction` with `fires: false` for it, and the
 * open notification would stay open forever. This function is the other half: every still-open
 * notification whose dedup key belongs to this rule type, so the sweep can resolve whichever ones
 * it did NOT just re-confirm as firing in the current tick.
 *
 * `dedupKey LIKE '<prefix>:%'` matches `buildNegativeStockDedupKey`/`buildExpiryDedupKey`'s own
 * exact string shape (`packages/domain/src/notifications/rule-engine.ts`) — the prefix IS the rule
 * type's real namespace, not a second, independently-drifting definition of it (I2).
 *
 * Deliberately cross-tenant by nature, same reasoning as `findNegativeStock`/`findExpiryQueue`:
 * this reads across every organization's open notifications in one query. `db` must be an
 * admin-equivalent connection.
 */
export const findOpenNotificationsByDedupPrefix = async (db: Db, dedupKeyPrefix: string): Promise<OpenNotificationByDedupPrefix[]> => {
  const rows = await db
    .select({ id: notifications.id, organizationId: notifications.organizationId, dedupKey: notifications.dedupKey })
    .from(notifications)
    .where(and(like(notifications.dedupKey, `${dedupKeyPrefix}:%`), isNull(notifications.resolvedAt)));

  return rows;
};
