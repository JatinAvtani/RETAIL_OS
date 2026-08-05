import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { StoreRepository } from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import type { SquareEnvironment, SquareOAuthConfig } from '@retailos/pos';
import { protectedProcedure, router } from '../trpc';
import { syncSquareCatalog, SquareNotConnectedError } from '../../integrations/square-catalog-sync';
import { syncSquareOrders, SquareLocationMissingError } from '../../integrations/square-orders-sync';

const syncCatalogInput = z.object({ storeId: z.string().uuid() });
const syncOrdersInput = z.object({ storeId: z.string().uuid() });

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
 * 006-04: the manual sync trigger — asked the user first, confirmed a protected tRPC mutation is
 * the right shape for now since no job queue/scheduler exists anywhere in this codebase yet
 * (`apps/worker` is still a placeholder). An OWNER/MANAGER with real store access calls this
 * directly; a future scheduled sweep (006-09) can call `syncSquareCatalog` the same way once a
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
      // the connection's own status/lastError already records the plain-language reason (006-13's
      // job to surface); the caller here just needs to know the sync didn't succeed.
      throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Square catalog sync failed. Check the integration status and try again.' });
    }
  }),

  /**
   * 006-05: same manual-trigger shape as `syncSquareCatalog` — a real scheduler is still
   * out of scope (`apps/worker` remains a placeholder), so this stays a protected mutation an
   * authenticated caller invokes directly. Distinct error for "no linked location" (a connection
   * can exist with a working token but no `externalLocationId` if the original OAuth callback's
   * location fetch failed — 006-03's own documented fallback) since Square's orders search
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
});
