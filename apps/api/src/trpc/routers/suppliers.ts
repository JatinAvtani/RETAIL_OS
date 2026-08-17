import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { SupplierRepository, SupplierProductRepository, ProductRepository } from '@retailos/db';
import { generateId } from '@retailos/domain';
import { protectedProcedure, router } from '../trpc';

const createInput = z.object({ name: z.string().min(1) });
const confirmedProductsInput = z.object({ supplierId: z.string().uuid() });
const getInput = z.object({ id: z.string().uuid() });

const contactInput = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  role: z.string().optional(),
});

const updateInput = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).optional(),
  contacts: z.array(contactInput).nullable().optional(),
  paymentTerms: z.string().nullable().optional(),
  leadTimeDaysContracted: z.number().int().nonnegative().nullable().optional(),
  deliveryDays: z.array(z.number().int().min(1).max(7)).nullable().optional(),
  orderCutoffTime: z.string().nullable().optional(),
  minOrderValue: z.string().nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

/**
 * 007-10: the review screen's correction flow needs to resolve an extracted supplier name to a
 * real `suppliers` row (or create one — an invoice from a genuinely new supplier is routine, not
 * an error state). `SupplierRepository` existed since 004-05 but had no tRPC surface at all until
 * this task became its first caller.
 */
export const suppliersRouter = router({
  list: protectedProcedure.query(({ ctx }) => {
    const supplierRepository = new SupplierRepository(ctx.db, ctx.session.organizationId);
    return supplierRepository.findAll();
  }),

  create: protectedProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    const supplierRepository = new SupplierRepository(ctx.db, ctx.session.organizationId);
    return supplierRepository.create({ id: generateId(), name: input.name });
  }),

  /** The detail/edit screen's read side — genuinely missing until now (found by the UI audit: `create`/`list` existed, nothing let a caller open a single supplier). */
  get: protectedProcedure.input(getInput).query(async ({ ctx, input }) => {
    const supplierRepository = new SupplierRepository(ctx.db, ctx.session.organizationId);
    const supplier = await supplierRepository.findById(input.id);
    if (!supplier) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Supplier not found.' });
    }
    return supplier;
  }),

  /** Every field here is a real, spec'd column (07 §7.5) — contacts/terms/lead-time/delivery schedule/status all existed in the schema with no way to edit them after creation. */
  update: protectedProcedure.input(updateInput).mutation(async ({ ctx, input }) => {
    const supplierRepository = new SupplierRepository(ctx.db, ctx.session.organizationId);
    const updated = await supplierRepository.update(input.id, {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.contacts !== undefined && { contacts: input.contacts }),
      ...(input.paymentTerms !== undefined && { paymentTerms: input.paymentTerms }),
      ...(input.leadTimeDaysContracted !== undefined && { leadTimeDaysContracted: input.leadTimeDaysContracted }),
      ...(input.deliveryDays !== undefined && { deliveryDays: input.deliveryDays }),
      ...(input.orderCutoffTime !== undefined && { orderCutoffTime: input.orderCutoffTime }),
      ...(input.minOrderValue !== undefined && { minOrderValue: input.minOrderValue }),
      ...(input.status !== undefined && { status: input.status }),
    });
    if (!updated) {
      // NOT_FOUND, not BAD_REQUEST — matches products.update/stores.get's own convention: from
      // this org's perspective a cross-tenant or nonexistent id is indistinguishable.
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Supplier not found.' });
    }
    return updated;
  }),

  /**
   * 008-05: which products a manager can add to a new PO line for this supplier — only CONFIRMED
   * `supplier_products` mappings (I7: an unconfirmed mapping has no reliable pack size/conversion
   * factor to trust a real order against). Enriched with each product's real name — the raw
   * mapping row only carries `productId`, and a create-PO screen needs a human-readable label, not
   * a bare uuid.
   *
   * A real, confirmed gap found by this task's own cross-tenant test: `findConfirmedBySupplier`
   * is correctly org-scoped (RLS + explicit WHERE), so a cross-org `supplierId` genuinely returns
   * zero rows — but that's a 200-empty, not the 404 this codebase's own convention requires for a
   * cross-org resource id (`stores.get`'s established shape). No data leaked either way, but the
   * WRONG response shape is still a real bug — an explicit existence check closes it.
   */
  confirmedProducts: protectedProcedure.input(confirmedProductsInput).query(async ({ ctx, input }) => {
    const supplierRepository = new SupplierRepository(ctx.db, ctx.session.organizationId);
    const supplier = await supplierRepository.findById(input.supplierId);
    if (!supplier) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Supplier not found.' });
    }

    const supplierProductRepository = new SupplierProductRepository(ctx.db, ctx.session.organizationId);
    const productRepository = new ProductRepository(ctx.db, ctx.session.organizationId);
    const mappings = await supplierProductRepository.findConfirmedBySupplier(input.supplierId);

    const withProductNames = await Promise.all(
      mappings.map(async (mapping) => {
        const product = await productRepository.findById(mapping.productId);
        return { ...mapping, productName: product?.name ?? null };
      })
    );
    return withProductNames;
  }),
});
