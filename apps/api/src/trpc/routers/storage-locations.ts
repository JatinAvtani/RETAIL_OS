import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { StorageLocationRepository, StoreRepository } from '@retailos/db';
import { generateId } from '@retailos/domain';
import { canAccessStore } from '@retailos/authz';
import { protectedProcedure, router } from '../trpc';
import type { db as Db } from '../context';

const listInput = z.object({ storeId: z.string().uuid() });
const createInput = z.object({ storeId: z.string().uuid(), name: z.string().min(1).max(120) });

/**
 * Same two-layer check every other store-scoped router uses: `canAccessStore` alone accepts ANY
 * storeId when the caller's `storeIds` is `'ALL'` (the common unrestricted OWNER/MANAGER case),
 * regardless of which organization that store belongs to. Only a real lookup through the
 * org-scoped `StoreRepository` catches a cross-org storeId.
 *
 * 404 rather than 403 for both the wrong-org and right-org-wrong-store cases — a 403 would confirm
 * the resource exists, which is itself an enumeration leak.
 */
const assertStoreAccess = async (
  db: typeof Db,
  session: { organizationId: string; storeIds: string[] | 'ALL' },
  storeId: string
) => {
  const storeRepository = new StoreRepository(db, session.organizationId);
  const store = await storeRepository.findById(storeId);
  if (!store || !canAccessStore(session, storeId)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
  }
};

/**
 * Storage locations: the physical zones within a store (walk-in fridge, dry store, bar well) that a
 * stocktake can be scoped to.
 *
 * The table, the repository and its tests all existed, and `stocktake.createByStorageLocation`
 * consumed a `storageLocationId` — but nothing could ever produce one: there was no way to list or
 * create a storage location through any API. That made the third stocktake mode unreachable by
 * construction rather than merely unlinked, and left `storage_locations` a table no user could put
 * a row in. This router is the missing half.
 *
 * Gated on a valid session rather than a specific Permission, matching `stores.ts`: the name of a
 * physical zone is not sensitive the way inventory quantities or costs are, and the real boundary
 * is *which store* a caller can reach, which `assertStoreAccess` enforces.
 */
export const storageLocationsRouter = router({
  listForStore: protectedProcedure.input(listInput).query(async ({ ctx, input }) => {
    await assertStoreAccess(ctx.db, ctx.session, input.storeId);
    const storageLocationRepository = new StorageLocationRepository(ctx.db, ctx.session.organizationId);
    return storageLocationRepository.findByStore(input.storeId);
  }),

  create: protectedProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    await assertStoreAccess(ctx.db, ctx.session, input.storeId);
    const storageLocationRepository = new StorageLocationRepository(ctx.db, ctx.session.organizationId);
    // ids are generated in application code (UUID v7), never by a column default.
    return storageLocationRepository.create({
      id: generateId(),
      storeId: input.storeId,
      name: input.name.trim(),
    });
  }),
});
