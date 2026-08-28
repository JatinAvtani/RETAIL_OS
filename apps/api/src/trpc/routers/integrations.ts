import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { StoreRepository, PosConnectionRepository, PosItemRepository, UnmappedSaleRepository } from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import { computeIntegrationHealthSummary } from '@retailos/metrics';
import { enqueueSquareSyncJob } from '@retailos/queue';
import type { SquareEnvironment, SquareOAuthConfig } from '@retailos/pos';
import { protectedProcedure, router } from '../trpc';
import { squareSyncQueue } from '../context';

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
 * the manual sync trigger. Used to run `syncSquareCatalog` SYNCHRONOUSLY inside the
 * request, back when no real job queue/worker existed in this codebase — `apps/worker` now has 9
 * real BullMQ workers (including the one consuming this exact job, `square-sync-processor.ts`), so
 * this enqueues and returns immediately instead. The caller observes the outcome through
 * `integrations.health` (the connection's own `status`/`lastError`/`lastSuccessfulSyncAt`, which
 * the sync functions themselves already update — see `syncSquareCatalog`'s own doc comment) rather
 * than through this mutation's response, matching how a webhook-triggered sync was always observed.
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

    // A connection must exist before enqueuing — same "not connected" rejection callers already
    // expect, checked HERE (not inside the worker job) so a genuinely bad request still gets an
    // immediate, synchronous error rather than silently queuing a job that will only fail later.
    const connectionRepository = new PosConnectionRepository(ctx.db, ctx.session.organizationId);
    const connection = await connectionRepository.findByStoreAndVendor(input.storeId, 'square');
    if (!connection) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'This store has no Square connection.' });
    }

    const config = readSquareConfig();
    if (!config) {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Square integration is not configured on this server.' });
    }

    await enqueueSquareSyncJob(squareSyncQueue, { kind: 'catalog', organizationId: ctx.session.organizationId, storeId: input.storeId });
    return { enqueued: true };
  }),

  /**
   * Same enqueue shape as `syncSquareCatalog` above. Still checks for a linked location
   * synchronously before enqueuing (Square's orders search requires a real location id, unlike the
   * catalog endpoint) — a connection can exist with a working token but no `externalLocationId` if
   * the original OAuth callback's location fetch failed (earlier work's own documented fallback).
   */
  syncSquareOrders: protectedProcedure.input(syncOrdersInput).mutation(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const connectionRepository = new PosConnectionRepository(ctx.db, ctx.session.organizationId);
    const connection = await connectionRepository.findByStoreAndVendor(input.storeId, 'square');
    if (!connection) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'This store has no Square connection.' });
    }
    if (!connection.externalLocationId) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'This store’s Square connection has no linked location — reconnect Square.' });
    }

    const config = readSquareConfig();
    if (!config) {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Square integration is not configured on this server.' });
    }

    await enqueueSquareSyncJob(squareSyncQueue, { kind: 'orders', organizationId: ctx.session.organizationId, storeId: input.storeId });
    return { enqueued: true };
  }),

  /**
   * the nightly reconciliation sweep, manually triggerable here for the same enqueue reasoning as
   * the two mutations above. A real trailing-3-day re-fetch, deliberately independent of the
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

    const connectionRepository = new PosConnectionRepository(ctx.db, ctx.session.organizationId);
    const connection = await connectionRepository.findByStoreAndVendor(input.storeId, 'square');
    if (!connection) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'This store has no Square connection.' });
    }
    if (!connection.externalLocationId) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'This store’s Square connection has no linked location — reconnect Square.' });
    }

    const config = readSquareConfig();
    if (!config) {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Square integration is not configured on this server.' });
    }

    await enqueueSquareSyncJob(squareSyncQueue, { kind: 'reconcile', organizationId: ctx.session.organizationId, storeId: input.storeId });
    return { enqueued: true };
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
