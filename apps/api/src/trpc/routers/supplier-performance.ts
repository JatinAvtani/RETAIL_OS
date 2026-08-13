import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { SupplierRepository, SupplierPerformanceEventRepository } from '@retailos/db';
import { computeSupplierPerformanceComponents, computeSupplierPerformanceTrend } from '@retailos/metrics';
import { protectedProcedure, router } from '../trpc';

const componentsInput = z.object({
  supplierId: z.string().uuid(),
  days: z.number().int().min(1).max(365).default(90),
});
const eventsInput = z.object({
  supplierId: z.string().uuid(),
  days: z.number().int().min(1).max(365).default(90),
  productId: z.string().uuid().optional(),
});
const trendInput = z.object({
  supplierId: z.string().uuid(),
  days: z.number().int().min(1).max(365).default(90),
});

const requirePermission = (permissions: string[], permission: string) => {
  if (!permissions.includes(permission)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
  }
};

/**
 * 008-13 (spec 05 §5.3.3, plan.md Phase 5): the real read surface over `supplier_performance_events`
 * — component metrics computed by `packages/metrics` (I2), never recomputed here. `purchasing:read`
 * gates both endpoints, matching `invoiceMatches.pending`'s own precedent that viewing purchasing
 * data is a read-only capability separate from `purchasing:write`/`purchasing:approve`.
 *
 * Both inputs are `supplierId`-scoped (a real, org-owned resource id) — correctly registered in the
 * cross-tenant registry, unlike `documents.accuracyTelemetry` (which has no `*Id` input at all and
 * is org-wide by design). A cross-org `supplierId` must return a real 404, matching
 * `suppliers.confirmedProducts`'s own established convention for this exact resource shape.
 */
export const supplierPerformanceRouter = router({
  components: protectedProcedure.input(componentsInput).query(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:read');
    const supplierRepository = new SupplierRepository(ctx.db, ctx.session.organizationId);
    const supplier = await supplierRepository.findById(input.supplierId);
    if (!supplier) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Supplier not found.' });
    }

    const eventRepository = new SupplierPerformanceEventRepository(ctx.db, ctx.session.organizationId);
    const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);
    const events = await eventRepository.findForSupplierSince(input.supplierId, since);

    return computeSupplierPerformanceComponents(
      events.map((e) => ({
        eventType: e.eventType,
        expectedValue: e.expectedValue,
        actualValue: e.actualValue,
        variance: e.variance,
      }))
    );
  }),

  /** The scorecard's drill-through — every real event behind a component figure, optionally narrowed to one product. */
  events: protectedProcedure.input(eventsInput).query(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:read');
    const supplierRepository = new SupplierRepository(ctx.db, ctx.session.organizationId);
    const supplier = await supplierRepository.findById(input.supplierId);
    if (!supplier) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Supplier not found.' });
    }

    const eventRepository = new SupplierPerformanceEventRepository(ctx.db, ctx.session.organizationId);
    const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);
    return input.productId !== undefined
      ? eventRepository.findForSupplierAndProductSince(input.supplierId, input.productId, since)
      : eventRepository.findForSupplierSince(input.supplierId, since);
  }),

  /**
   * 008-15 (plan.md: "components side by side WITH TRENDS") — each component's current-window value
   * next to the SAME metric over the immediately-preceding equal-length window, plus a real
   * up/down/flat direction. Confirmed with the user via `AskUserQuestion`: period-over-period, not a
   * bucketed time series — two real event reads, no new domain logic beyond `computeSupplierPerformanceTrend`.
   */
  trend: protectedProcedure.input(trendInput).query(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:read');
    const supplierRepository = new SupplierRepository(ctx.db, ctx.session.organizationId);
    const supplier = await supplierRepository.findById(input.supplierId);
    if (!supplier) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Supplier not found.' });
    }

    const eventRepository = new SupplierPerformanceEventRepository(ctx.db, ctx.session.organizationId);
    const windowMs = input.days * 24 * 60 * 60 * 1000;
    const now = new Date();
    const currentWindowStart = new Date(now.getTime() - windowMs);
    const previousWindowStart = new Date(currentWindowStart.getTime() - windowMs);

    const [currentEvents, previousEvents] = await Promise.all([
      eventRepository.findForSupplierSince(input.supplierId, currentWindowStart),
      eventRepository.findForSupplierBetween(input.supplierId, previousWindowStart, currentWindowStart),
    ]);

    return computeSupplierPerformanceTrend(
      currentEvents.map((e) => ({ eventType: e.eventType, expectedValue: e.expectedValue, actualValue: e.actualValue, variance: e.variance })),
      previousEvents.map((e) => ({ eventType: e.eventType, expectedValue: e.expectedValue, actualValue: e.actualValue, variance: e.variance }))
    );
  }),
});
