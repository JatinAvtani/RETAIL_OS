import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLogs,
  createDb,
  categories,
  documentExtractions,
  documents,
  extractionCorrections,
  goodsReceiptLines,
  goodsReceipts,
  hashPassword,
  invoiceMatchLines,
  invoiceMatches,
  supplierPerformanceEvents,
  lots,
  memberships,
  menuItems,
  organizations,
  outboxEvents,
  posConnections,
  posItems,
  productVariants,
  products,
  recipeComponents,
  recipes,
  salesCsvImports,
  salesTransactionLines,
  salesTransactions,
  savedCsvColumnMappings,
  stockCountLines,
  stockCounts,
  stockLevels,
  stockMovements,
  purchaseOrderLines,
  purchaseOrders,
  storageLocations,
  stores,
  supplierProducts,
  suppliers,
  unmappedSales,
  users,
} from '@retailos/db';
import { createRedisClient } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../server';
import { appRouter } from './router';
import { resourceScopedProcedures } from './cross-tenant-registry';
import { extractionQueue } from './context';
import type { FastifyInstance } from 'fastify';

/**
 * Task 003-13, spec 14 §14.3, the closing merge-gate suite: for every registered route that fetches
 * a resource by id, prove that tenant B's session can never read tenant A's resource — 403/404,
 * never 200. Two enforcement mechanisms in one file:
 *
 * 1. A completeness check: every `query`/`mutation` procedure actually registered on `appRouter`
 *    that takes an `id`-shaped input MUST appear in `resourceScopedProcedures` — this is what
 *    makes "every future endpoint inherits it automatically" true rather than aspirational. Add a
 *    new resource-fetching endpoint without registering it here, and this suite fails loudly on
 *    the next run, not silently.
 * 2. The actual attack, run once per registered entry: seed a real resource in tenant A, log in as
 *    a real tenant B user, call the real endpoint over real HTTP with tenant B's session against
 *    tenant A's resource id, assert the response is never a 200.
 */
describe('cross-tenant suite (003-13 merge gate)', () => {
  let app: FastifyInstance;
  const { db } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos'
  );
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    // Full dependency-ordered teardown, deepest dependents first. Every table below was added as
    // 005-16's registry entries surfaced it via a real FK violation, one at a time, each fix
    // cascading into the next until the actual full dependency graph was worked out explicitly
    // (rather than continuing to patch reactively) — recorded here so it doesn't need
    // re-discovering:
    //   stock_count_lines -> stock_counts, products
    //   stock_counts -> stores, users (createdBy/submittedBy/approvedByUserId)
    //   stock_movements -> stores, products, product_variants, lots, users (actorUserId)
    //   stock_levels -> stores, products, product_variants
    //   lots -> stores, products, product_variants
    //   audit_logs -> organizations, users (actorUserId)
    //   outbox_events -> organizations
    //   recipe_components -> recipes, products
    //   recipes -> organizations
    //   product_variants -> products
    //   pos_items -> menu_items (menuItemId, 006-11)
    //   products -> categories, units, storage_locations
    //   storage_locations -> stores
    //   categories -> organizations
    //   stores -> organizations
    //   documents -> stores, users (uploadedByUserId, 007-02) — must be gone before BOTH the
    //     createdUserIds loop below AND the stores delete further down; found the same way as
    //     every entry above it, a real FK violation surfacing once documents.confirmUpload's
    //     registry entry became the first to genuinely write a documents row in this shared file.
    // Every row referencing a user (stock_counts' three *ByUserId columns, stock_movements'/
    // audit_logs' actorUserId, documents' uploadedByUserId) must be gone BEFORE the createdUserIds
    // loop deletes those users — a first version of this cleanup deleted users first (matching the
    // position of every pre-005-16 seeded-resource cleanup, none of which reference users), which
    // genuinely failed with a real FK violation and — because afterEach itself threw — silently
    // corrupted every subsequent test's isolation in the same run, cascading into failures on
    // entries this session never touched (stores.get, products.get, ...).
    for (const orgId of createdOrgIds) {
      const orgCounts = await db.select({ id: stockCounts.id }).from(stockCounts).where(eq(stockCounts.organizationId, orgId));
      for (const c of orgCounts) {
        await db.delete(stockCountLines).where(eq(stockCountLines.stockCountId, c.id));
      }
      await db.delete(stockCounts).where(eq(stockCounts.organizationId, orgId));
      await db.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      // 007-05: documents.confirmUpload's registry entry now enqueues a real BullMQ job
      // (jobId === documentId) — cleaned up before the row itself is deleted, same reasoning as
      // documents.test.ts's own afterEach, so this shared suite doesn't leave real jobs behind in
      // Redis on every run.
      const orgDocuments = await db.select({ id: documents.id }).from(documents).where(eq(documents.organizationId, orgId));
      for (const doc of orgDocuments) {
        await (await extractionQueue.getJob(doc.id))?.remove();
      }
      // 007-09/007-10: documents.getForReview/.approve/.reject/.confirmLineMapping's registry
      // entries now seed real document_extractions AND extraction_corrections rows
      // (extraction_corrections.extraction_id -> document_extractions.id, which itself references
      // documents.id) — both must be deleted before the documents delete below, or the FK blocks it.
      // Same recurring FK-teardown-order bug class this shared fixture has hit repeatedly.
      await db.delete(extractionCorrections).where(eq(extractionCorrections.organizationId, orgId));
      await db.delete(documentExtractions).where(eq(documentExtractions.organizationId, orgId));
      // 008-10: invoiceMatches.get/.getByDocument/.pending's registry entries seed real
      // invoice_matches/invoice_match_lines rows referencing documents, purchase_order_lines, AND
      // goods_receipt_lines — all three must be gone before this SAME loop's own documents/
      // purchase_order_lines/goods_receipt_lines deletes further down, the same recurring
      // FK-teardown-order bug class this shared fixture has hit repeatedly.
      // 008-13: supplierPerformance.components/.events registry entries + the runMatch/confirmReceipt
      // calls the invoiceMatches/goodsReceipts entries above already make all write real
      // supplier_performance_events rows referencing documents/goods_receipts/purchase_orders — must
      // be gone before every one of those parent-table deletes in this same function.
      await db.delete(supplierPerformanceEvents).where(eq(supplierPerformanceEvents.organizationId, orgId));
      await db.delete(invoiceMatchLines).where(eq(invoiceMatchLines.organizationId, orgId));
      await db.delete(invoiceMatches).where(eq(invoiceMatches.organizationId, orgId));
      await db.delete(documents).where(eq(documents.organizationId, orgId));
      // 008-07: goodsReceipts.confirmReceipt/.get's registry entries seed real
      // goods_receipts/goods_receipt_lines rows referencing purchase_order_lines — must be gone
      // BEFORE purchase_order_lines is deleted below, not just before lots further down (this is
      // an earlier iteration of the SAME loop deleting purchase_order_lines, so the ordering
      // matters within this one pass too). lots.goods_receipt_line_id forms a genuine mutual FK
      // cycle with goods_receipt_lines.lot_id — nulled here too, ahead of the `lots` delete later
      // in this same function, since a goods_receipt_lines row created here may already have set it.
      await db.update(lots).set({ goodsReceiptLineId: null }).where(eq(lots.organizationId, orgId));
      await db.delete(goodsReceiptLines).where(eq(goodsReceiptLines.organizationId, orgId));
      await db.delete(goodsReceipts).where(eq(goodsReceipts.organizationId, orgId));
      // 008-05: purchaseOrders.create/addLine/submit/approve/reject/send/cancel's registry entries
      // now seed real purchase_order_lines/purchase_orders rows — purchase_orders references users
      // via createdByUserId/submittedByUserId/approvedByUserId/rejectedByUserId/sentByUserId/
      // cancelledByUserId, so both must be gone before the createdUserIds loop below, the same
      // recurring FK-teardown-order bug class this shared fixture has hit repeatedly.
      await db.delete(purchaseOrderLines).where(eq(purchaseOrderLines.organizationId, orgId));
      await db.delete(purchaseOrders).where(eq(purchaseOrders.organizationId, orgId));
    }

    for (const userId of createdUserIds) {
      const tokens = await redis.smembers(`user-sessions:${userId}`);
      if (tokens.length > 0) {
        await redis.del(...tokens.map((t) => `session:${t}`), `user-sessions:${userId}`);
      }
      await db.delete(memberships).where(eq(memberships.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    for (const orgId of createdOrgIds) {
      await db.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      // goods_receipts/goods_receipt_lines and the lots.goods_receipt_line_id <-> mutual FK cycle
      // are already fully cleaned up in the loop above (must happen before purchase_order_lines is
      // deleted there) — this delete only needs to handle the remaining lots rows.
      await db.delete(lots).where(eq(lots.organizationId, orgId));
      await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));

      const orgRecipes = await db.select({ id: recipes.id }).from(recipes).where(eq(recipes.organizationId, orgId));
      for (const r of orgRecipes) {
        await db.delete(recipeComponents).where(eq(recipeComponents.recipeId, r.id));
      }
      await db.delete(recipes).where(eq(recipes.organizationId, orgId));

      // 007-10: documents.confirmLineMapping's registry entry now seeds real supplier_products
      // rows (references both products AND suppliers) — must be gone before either parent table's
      // rows are deleted below.
      await db.delete(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      const orgProducts = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await db.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await db.delete(products).where(eq(products.organizationId, orgId));
      await db.delete(suppliers).where(eq(suppliers.organizationId, orgId));
      await db.delete(storageLocations).where(eq(storageLocations.organizationId, orgId));
      await db.delete(posConnections).where(eq(posConnections.organizationId, orgId));
      await db.delete(salesCsvImports).where(eq(salesCsvImports.organizationId, orgId));
      await db.delete(savedCsvColumnMappings).where(eq(savedCsvColumnMappings.organizationId, orgId));
      await db.delete(unmappedSales).where(eq(unmappedSales.organizationId, orgId));
      await db.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
      await db.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
      await db.delete(posItems).where(eq(posItems.organizationId, orgId));
      await db.delete(menuItems).where(eq(menuItems.organizationId, orgId));
      await db.delete(stores).where(eq(stores.organizationId, orgId));
      await db.delete(categories).where(eq(categories.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdUserIds.length = 0;
    createdOrgIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  const uniqueEmail = (label: string) =>
    `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  /** A real org with a real, logged-in OWNER — returns the org id and a real session cookie. */
  const setUpRealTenant = async (label: string): Promise<{ organizationId: string; sessionCookie: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `${label} Org`,
      slug: `${label.toLowerCase()}-org-${organizationId}`,
      baseCurrency: 'USD',
    });

    const email = uniqueEmail(`cross-tenant-${label.toLowerCase()}`);
    const password = 'a-genuinely-long-password-123';
    const userId = generateId();
    createdUserIds.push(userId);
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({ id: userId, email, passwordHash, emailVerifiedAt: new Date() });
    await db.insert(memberships).values({
      id: generateId(),
      organizationId,
      userId,
      role: 'OWNER',
      acceptedAt: new Date(),
    });

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/trpc/auth.login',
      payload: { email, password },
    });
    const sessionCookie = loginResponse.cookies.find((c) => c.name === '__Host-session')!.value;

    return { organizationId, sessionCookie };
  };

  it('every registered id-shaped procedure is covered by the cross-tenant registry', () => {
    const registeredPaths = new Set(resourceScopedProcedures.map((p) => p.path));

    // appRouter._def.record is a NESTED tree ({ stores: { get: Procedure, list: Procedure }, ... }),
    // not a flat dotted map — walked recursively to build real dotted paths ('stores.get').
    type ProcedureLike = { _def: { type?: string; inputs?: unknown[] } };
    type RouterNode = ProcedureLike | { [key: string]: RouterNode };

    const isProcedure = (node: RouterNode): node is ProcedureLike =>
      typeof (node as ProcedureLike)._def?.type === 'string';

    const walk = (node: RouterNode, prefix: string): string[] => {
      if (isProcedure(node)) {
        const def = node._def;
        if (def.type === 'subscription') {
          return [];
        }
        const inputSchema = def.inputs?.[0] as { shape?: Record<string, unknown> } | undefined;
        // Catches 'id' AND any 'xxxId' field (productId, storeId, ...) — a literal-'id'-only check
        // silently misses an endpoint like requestImageUpload({ productId }), which is exactly as
        // resource-scoped as one shaped { id }, just with a more specific field name.
        const looksResourceScoped = Boolean(
          inputSchema?.shape && Object.keys(inputSchema.shape).some((key) => key === 'id' || key.endsWith('Id'))
        );
        return looksResourceScoped ? [prefix] : [];
      }
      return Object.entries(node).flatMap(([key, child]) =>
        walk(child, prefix ? `${prefix}.${key}` : key)
      );
    };

    const resourceScopedPaths = walk(appRouter._def.record as RouterNode, '');
    const uncovered = resourceScopedPaths.filter((path) => !registeredPaths.has(path));

    expect(uncovered).toEqual([]);
  });

  it.each(resourceScopedProcedures)(
    'tenant B is denied fetching tenant A\'s resource via $path',
    async (procedure) => {
      const tenantA = await setUpRealTenant('Tenant-A');
      const tenantB = await setUpRealTenant('Tenant-B');

      const resourceId = await procedure.seedResource(db, tenantA.organizationId);
      const input = await procedure.buildInput(resourceId, tenantA.organizationId, db);

      const response =
        procedure.type === 'query'
          ? await app.inject({
              method: 'GET',
              url: `/trpc/${procedure.path}?input=${encodeURIComponent(JSON.stringify(input))}`,
              cookies: { '__Host-session': tenantB.sessionCookie },
            })
          : await app.inject({
              method: 'POST',
              url: `/trpc/${procedure.path}`,
              payload: input,
              cookies: { '__Host-session': tenantB.sessionCookie },
            });

      expect(response.statusCode).not.toBe(200);
      expect([403, 404]).toContain(response.statusCode);
    }
  );

  it.each(resourceScopedProcedures)(
    'tenant A can still fetch their OWN resource via $path (the check is not blocking everyone)',
    async (procedure) => {
      const tenantA = await setUpRealTenant('Tenant-A');

      const resourceId = await procedure.seedResource(db, tenantA.organizationId);
      const input = await procedure.buildInput(resourceId, tenantA.organizationId, db);

      const response =
        procedure.type === 'query'
          ? await app.inject({
              method: 'GET',
              url: `/trpc/${procedure.path}?input=${encodeURIComponent(JSON.stringify(input))}`,
              cookies: { '__Host-session': tenantA.sessionCookie },
            })
          : await app.inject({
              method: 'POST',
              url: `/trpc/${procedure.path}`,
              payload: input,
              cookies: { '__Host-session': tenantA.sessionCookie },
            });

      expect(response.statusCode).toBe(200);
    }
  );
});
