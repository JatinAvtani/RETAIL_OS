import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { StoreRepository, PosConnectionRepository, PosItemRepository, UnmappedSaleRepository } from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import { computeIntegrationHealthSummary } from '@retailos/metrics';
import type { SquareEnvironment, SquareOAuthConfig } from '@retailos/pos';
import { protectedProcedure, router } from '../trpc';
import { syncSquareCatalog, SquareNotConnectedError } from '../../integrations/square-catalog-sync';
import { syncSquareOrders, reconcileSquareOrders, SquareLocationMissingError } from '../../integrations/square-orders-sync';

const syncCatalogInput = z.object({ storeId: z.string().uuid() });
const syncOrdersInput = z.object({ storeId: z.string().uuid() });
const reconcileOrdersInput = z.object({ storeId: z.string().uuid() });

const readSquareConfig = (): SquareOAuthConfig | null => {
  const applicationId = process.env.SQUARE_APPLICATION_ID;
  const applicationSecret = process.env.SQUARE_APPLICATION_SECRET;
  const redirectUri = process.env.SQUARE_REDIRECT_URI;
  const environment = (process.env.SQUARE_ENVIRONMENT ?? 'sandbox') as SquareEnvironment;
  if (!applicationId || !applicationSecret || !redirectUri) {
    return null;
  }
  return { applicationId, applicationSecret, redirectUri, environment };
};

/**
 * the manual sync trigger — asked the user first, confirmed a protected tRPC mutation is
 * the right shape for now since no job queue/scheduler exists anywhere in this codebase yet
 * (`apps/worker` is still a placeholder). An OWNER/MANAGER with real store access calls this
 * directly; a future scheduled sweep can call `syncSquareCatalog` the same way once a
 * real worker exists, without this endpoint needing to change.
 */
export const integrationsRouter = router({
  syncSquareCatalog: protectedProcedure.input(syncCatalogInput).mutation(async ({ ctx, input }) => {
    // Same two-layer store check every store-scoped endpoint in this codebase uses — canAccessStore
    // alone is blind to organization when session.storeIds is 'ALL'.
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const config = readSquareConfig();
    if (!config) {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Square integration is not configured on this server.' });
    }

    try {
      return await syncSquareCatalog(
        ctx.db,
        ctx.session.organizationId,
        input.storeId,
        config,
        process.env.POS_TOKEN_ENCRYPTION_KEY
      );
    } catch (err) {
      if (err instanceof SquareNotConnectedError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      // A real Square API failure (network, 4xx/5xx, decryption failure on a corrupted token) —
      // the connection's own status/lastError already records the plain-language reason (earlier work's
      // job to surface); the caller here just needs to know the sync didn't succeed.
      throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Square catalog sync failed. Check the integration status and try again.' });
    }
  }),

  /**
   * same manual-trigger shape as `syncSquareCatalog` — a real scheduler is still
   * out of scope (`apps/worker` remains a placeholder), so this stays a protected mutation an
   * authenticated caller invokes directly. Distinct error for "no linked location" (a connection
   * can exist with a working token but no `externalLocationId` if the original OAuth callback's
   * location fetch failed — earlier work's own documented fallback) since Square's orders search
   * requires a real location id, unlike the catalog endpoint.
   */
  syncSquareOrders: protectedProcedure.input(syncOrdersInput).mutation(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const config = readSquareConfig();
    if (!config) {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Square integration is not configured on this server.' });
    }

    try {
      return await syncSquareOrders(
        ctx.db,
        ctx.session.organizationId,
        input.storeId,
        config,
        process.env.POS_TOKEN_ENCRYPTION_KEY
      );
    } catch (err) {
      if (err instanceof SquareNotConnectedError || err instanceof SquareLocationMissingError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Square orders sync failed. Check the integration status and try again.' });
    }
  }),

  /**
   * the nightly reconciliation sweep, manually triggerable here for the same reason every
   * other sync in this codebase is a protected mutation — no scheduler exists yet (`apps/worker` is
   * still a placeholder). A real trailing-3-day re-fetch, deliberately independent of the
   * connection's own incremental watermark (see `reconcileSquareOrders`'s own doc comment) — catches
   * a missed webhook, a vendor-side correction, or a silent sync failure that the incremental sync
   * alone would never revisit.
   */
  reconcileSquareOrders: protectedProcedure.input(reconcileOrdersInput).mutation(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const config = readSquareConfig();
    if (!config) {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Square integration is not configured on this server.' });
    }

    try {
      return await reconcileSquareOrders(
        ctx.db,
        ctx.session.organizationId,
        input.storeId,
        config,
        process.env.POS_TOKEN_ENCRYPTION_KEY
      );
    } catch (err) {
      if (err instanceof SquareNotConnectedError || err instanceof SquareLocationMissingError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Square reconciliation sweep failed. Check the integration status and try again.' });
    }
  }),

  /**
   * every connection's health, in the customer's
   * language — "integration failures must be visible to the customer... a silently broken sync
   * produces confidently wrong analytics, which is the specific outcome this entire architecture
   * is designed to prevent." Org-wide (every store's every connection at once), not
   * `*Id`-shaped — each connection's `storeId`/`organizationId` are already read straight off the
   * row `PosConnectionRepository.findAllForOrganization` returns (itself tenant-scoped), so this
   * needs no separate per-connection access check the way a single-resource `get` would.
   * `computeIntegrationHealthSummary` (packages/metrics) is the one registered place these numbers
   * are assembled (I2) — this procedure only fetches the raw counts/timestamps and hands them in,
   * never computing the freshness lag or plain-language error itself.
   */
  health: protectedProcedure.query(async ({ ctx }) => {
    const connectionRepository = new PosConnectionRepository(ctx.db, ctx.session.organizationId);
    const posItemRepository = new PosItemRepository(ctx.db, ctx.session.organizationId);
    const unmappedSaleRepository = new UnmappedSaleRepository(ctx.db, ctx.session.organizationId);
    const now = new Date();

    const connections = await connectionRepository.findAllForOrganization();

    return Promise.all(
      connections.map(async (connection) => {
        const [unmappedItems, quarantinedSales] = await Promise.all([
          posItemRepository.findUnmapped(connection.storeId),
          unmappedSaleRepository.findUnresolved(connection.storeId),
        ]);

        return computeIntegrationHealthSummary({
          connectionId: connection.id,
          storeId: connection.storeId,
          status: connection.status,
          lastError: connection.lastError,
          lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
          unmappedItemCount: unmappedItems.length,
          quarantineCount: quarantinedSales.length,
          now,
        });
      })
    );
  }),
});
