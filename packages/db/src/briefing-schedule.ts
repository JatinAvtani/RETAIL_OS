import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index';
import { stores } from './schema/index';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type ActiveStoreForScheduling = {
  organizationId: string;
  storeId: string;
  timezone: string;
};

/**
 * The real read side of "06:00 store-local, scheduled per tenant timezone" — deliberately
 * cross-tenant, same reasoning as `findUnpublishedOutboxEvents`/`findExpiryQueue`: a scheduling
 * sweep needs every active store across every tenant to re-derive and re-register each one's own
 * real UTC cron time (via `resolveUtcCronForLocalTime`, `packages/domain`), not a single
 * organization's scoped request. `db` must be an admin-equivalent connection, not a
 * `TenantScopedRepository`.
 *
 * Only `status: 'active'` stores — a closed store has no one to brief, and scheduling a job for it
 * would just fire into a real recipient list that resolves to nobody every day forever.
 */
export const findActiveStoresForScheduling = async (db: Db): Promise<ActiveStoreForScheduling[]> => {
  const rows = await db
    .select({ organizationId: stores.organizationId, storeId: stores.id, timezone: stores.timezone })
    .from(stores)
    .where(eq(stores.status, 'active'));

  return rows;
};
