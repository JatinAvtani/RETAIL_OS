import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { StoreRepository, PosItemRepository, MenuItemRepository } from '@retailos/db';
import { suggestMenuItemMatches } from '@retailos/domain';
import { canAccessStore } from '@retailos/authz';
import { protectedProcedure, router } from '../trpc';

const listUnmappedInput = z.object({ storeId: z.string().uuid() });
const mapToMenuItemInput = z.object({ id: z.string().uuid(), menuItemId: z.string().uuid() });
const ignoreInput = z.object({ id: z.string().uuid() });

/**
 * 006-11 (plan.md Phase 6, the LAST task in EPIC-006): unmapped POS items ranked by sales volume
 * descending ("mapping the top 20 items covers ~80% of revenue"), each with fuzzy-suggested menu
 * item matches for a human to confirm or reject (I9 — a confirmed mapping is permanent and
 * deterministic, never automatic). `PosItemRepository.findUnmapped`/`mapToMenuItem` existed since
 * 006-01/006-04 with no caller until this task; `ignore` is new here, giving a genuinely non-menu
 * line (gift card, service charge) somewhere to go instead of sitting unresolved forever.
 */
export const posItemsRouter = router({
  /** Every row's `suggestions` is computed server-side from the org's own menu items — never sent as a raw list for the client to score itself, keeping the matching logic in one place. */
  listUnmapped: protectedProcedure.input(listUnmappedInput).query(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const posItemRepository = new PosItemRepository(ctx.db, ctx.session.organizationId);
    const menuItemRepository = new MenuItemRepository(ctx.db, ctx.session.organizationId);
    const [unmappedItems, menuItems] = await Promise.all([
      posItemRepository.findUnmappedRankedByVolume(input.storeId),
      menuItemRepository.findAll(),
    ]);

    const candidates = menuItems.map((menuItem) => ({ id: menuItem.id, name: menuItem.name }));
    return unmappedItems.map((item) => ({
      ...item,
      suggestions: suggestMenuItemMatches(item.name, candidates).slice(0, 5),
    }));
  }),

  mapToMenuItem: protectedProcedure.input(mapToMenuItemInput).mutation(async ({ ctx, input }) => {
    const posItemRepository = new PosItemRepository(ctx.db, ctx.session.organizationId);
    const item = await posItemRepository.findById(input.id);
    if (!item) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'POS item not found.' });
    }

    const menuItemRepository = new MenuItemRepository(ctx.db, ctx.session.organizationId);
    const menuItem = await menuItemRepository.findById(input.menuItemId);
    if (!menuItem) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Menu item not found.' });
    }

    const mapped = await posItemRepository.mapToMenuItem(input.id, input.menuItemId);
    if (!mapped) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'POS item not found.' });
    }
    return mapped;
  }),

  /** Marks a POS item as genuinely never needing a menu-item mapping — a gift card, a service charge, a tip line. */
  ignore: protectedProcedure.input(ignoreInput).mutation(async ({ ctx, input }) => {
    const posItemRepository = new PosItemRepository(ctx.db, ctx.session.organizationId);
    const item = await posItemRepository.findById(input.id);
    if (!item) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'POS item not found.' });
    }

    const ignored = await posItemRepository.ignore(input.id);
    if (!ignored) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'POS item not found.' });
    }
    return ignored;
  }),
});
