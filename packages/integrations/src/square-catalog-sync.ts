import {
  createDb,
  PosConnectionRepository,
  PosItemRepository,
  type PosConnectionStatus,
} from '@retailos/db';
import {
  decryptToken,
  encryptToken,
  fetchSquareCatalog,
  refreshSquareToken,
  type SquareOAuthConfig,
} from '@retailos/pos';
import { generateId } from '@retailos/domain';

type Db = ReturnType<typeof createDb>['db'];

export class SquareNotConnectedError extends Error {
  constructor() {
    super('This store has no Square connection.');
    this.name = 'SquareNotConnectedError';
  }
}

export type SquareCatalogSyncResult = {
  itemsSeen: number;
  variationsUpserted: number;
  itemsDelisted: number;
};

/**
 * "items → `pos_items` with `mapping_status = 'UNMAPPED'`. Deleted
 * upstream items are marked, not deleted." One catalog ITEM with N variations becomes N
 * `pos_items` rows — same convention `PosItemRepository`/earlier work already established: a `pos_items`
 * row is one priced, orderable SKU (the variation), not the parent grouping, matching how
 * `sales_transaction_lines.posItemId` will need to reference the exact thing that was sold.
 *
 * Lives in `packages/integrations`, not `apps/api` or `apps/worker` directly — it composes both a
 * vendor API client (`@retailos/pos`) and a tenant repository (`@retailos/db`), and BOTH the API
 * (a manual "sync now" trigger) and the worker (the real async job processor — see
 * `SQUARE_SYNC_QUEUE_NAME`) need to call the identical function; apps cannot import from other apps
 * (module-boundary rule), so this had to live in a shared package once the sync moved off the
 * request path.
 *
 * Refreshes the access token proactively when Square's own `token_expires_at` has passed, mirroring
 * the design's "refresh automatically; alert on refresh failure" — a sync attempt is the natural
 * moment to check.
 */
export const syncSquareCatalog = async (
  db: Db,
  organizationId: string,
  storeId: string,
  config: SquareOAuthConfig,
  encryptionKey: string | undefined
): Promise<SquareCatalogSyncResult> => {
  const connectionRepository = new PosConnectionRepository(db, organizationId);
  const connection = await connectionRepository.findByStoreAndVendor(storeId, 'square');
  if (!connection) {
    throw new SquareNotConnectedError();
  }

  let accessToken = decryptToken(connection.accessTokenCiphertext, encryptionKey);

  const tokenExpired = connection.tokenExpiresAt !== null && connection.tokenExpiresAt <= new Date();
  if (tokenExpired && connection.refreshTokenCiphertext) {
    try {
      const refreshed = await refreshSquareToken(config, decryptToken(connection.refreshTokenCiphertext, encryptionKey));
      accessToken = refreshed.accessToken;
      await connectionRepository.upsert({
        id: connection.id,
        storeId: connection.storeId,
        vendor: 'square',
        externalAccountId: connection.externalAccountId,
        ...(connection.externalLocationId !== null ? { externalLocationId: connection.externalLocationId } : {}),
        accessTokenCiphertext: encryptToken(refreshed.accessToken, encryptionKey),
        refreshTokenCiphertext: encryptToken(refreshed.refreshToken, encryptionKey),
        tokenExpiresAt: refreshed.expiresAt,
        ...(connection.connectedByUserId !== null ? { connectedByUserId: connection.connectedByUserId } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Square token refresh failed.';
      await connectionRepository.updateStatus(connection.id, 'EXPIRED' satisfies PosConnectionStatus, message);
      throw err;
    }
  }

  const itemRepository = new PosItemRepository(db, organizationId);
  // Cursor advances (via the loop below) in the same pass as the upserts it gates — a failed
  // upsert throws before the next fetchSquareCatalog call, so no page is ever skipped past.
  const syncStartedAt = new Date();
  let cursor: string | undefined;
  let itemsSeen = 0;
  let variationsUpserted = 0;

  try {
    do {
      const page = await fetchSquareCatalog(config, accessToken, cursor);
      for (const item of page.items) {
        itemsSeen += 1;
        if (item.isDeleted) continue; // handled by markNotSeenSinceAsDelisted below, not upserted
        for (const variation of item.variations) {
          await itemRepository.upsert({
            id: generateId(),
            storeId,
            source: 'square',
            externalId: variation.externalId,
            name: item.variations.length > 1 ? `${item.name} — ${variation.name}` : item.name,
            ...(variation.price !== undefined
              ? { price: variation.price.amount, currency: variation.price.currency }
              : {}),
            ...(item.category !== undefined ? { category: item.category } : {}),
          });
          variationsUpserted += 1;
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Square catalog sync failed.';
    await connectionRepository.updateStatus(connection.id, 'DEGRADED' satisfies PosConnectionStatus, message);
    throw err;
  }

  const delisted = await itemRepository.markNotSeenSinceAsDelisted(storeId, 'square', syncStartedAt);
  await connectionRepository.recordSuccessfulSync(connection.id);

  return { itemsSeen, variationsUpserted, itemsDelisted: delisted.length };
};
