import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { NotificationRepository, StoreRepository } from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import { protectedProcedure, router } from '../trpc';

/**
 * The in-app notification centre's API surface: unread count, grouping, mark-read, direct action
 * links. Every write here is deliberately narrow: this router composes
 * `NotificationRepository`'s already-built methods, adding no new business logic of its own —
 * matching every other router's own "thin adapter over already-tested library code" shape.
 *
 * "Grouping" is NOT a query-time concern here — `aggregateNotificationContent` already collapses
 * multiple firings sharing one `aggregationGroup` into a single real `notifications` row at WRITE
 * time (e.g. 5 expiring lots become 1 notification, not 5). This router lists whatever real rows
 * already exist; the UI groups by `severity` for visual scannability, a presentation concern, not
 * a second aggregation mechanism.
 */
export const notificationsRouter = router({
  /** The in-app centre's real list — unresolved, store-or-org-wide, most recent first. */
  list: protectedProcedure.input(z.object({ storeId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const organizationId = ctx.session.organizationId;

    // The two-layer store check every other store-scoped procedure in this codebase uses
    // (assistant.briefing, purchase-orders.ts, inventory.ts...) — BOTH layers load-bearing:
    // canAccessStore alone accepts ANY org's storeId for a storeIds:'ALL' caller.
    const storeRepository = new StoreRepository(ctx.db, organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const notificationRepository = new NotificationRepository(ctx.db, organizationId);
    return notificationRepository.findUnresolvedForStore(input.storeId);
  }),

  /** The centre's unread badge — a cheap count query, same store-ownership check as `list`. */
  unreadCount: protectedProcedure.input(z.object({ storeId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const organizationId = ctx.session.organizationId;
    const storeRepository = new StoreRepository(ctx.db, organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const notificationRepository = new NotificationRepository(ctx.db, organizationId);
    const count = await notificationRepository.countUnreadForStore(input.storeId);
    return { count };
  }),

  /**
   * Idempotent (`NotificationRepository.markRead` only writes when `readAt IS NULL`) — a second
   * call for an already-read notification is a safe no-op, not an error, since a UI can plausibly
   * fire this more than once for the same id (a re-render, a race between two open tabs).
   */
  markRead: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const notificationRepository = new NotificationRepository(ctx.db, ctx.session.organizationId);
    const existing = await notificationRepository.findById(input.id);
    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Notification not found.' });
    }
    await notificationRepository.markRead(input.id);
    return { id: input.id };
  }),

  /**
   * The "direct action links" endpoint — records that a human took a genuine action on this
   * notification (e.g. followed a link to actually order more flour), distinct from merely having
   * seen it (`markRead`). Future action-rate tracking is the real eventual consumer of this
   * signal; for now this provides the write path a UI action button needs.
   */
  markActed: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const notificationRepository = new NotificationRepository(ctx.db, ctx.session.organizationId);
    const existing = await notificationRepository.findById(input.id);
    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Notification not found.' });
    }
    await notificationRepository.markActed(input.id);
    return { id: input.id };
  }),
});
