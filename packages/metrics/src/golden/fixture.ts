import { eq } from 'drizzle-orm';
import type { createDb } from '@retailos/db';
import {
  documents,
  menuItems,
  organizations,
  posItems,
  products,
  productVariants,
  stores,
  suppliers,
  supplierProducts,
  units,
  withTenantContext,
  LotRepository,
  MovementService,
  RecipeRepository,
  SalesTransactionRepository,
  SupplierPriceRepository,
} from '@retailos/db';
import { generateId } from '@retailos/domain';

type Db = ReturnType<typeof createDb>['db'];

/**
 * The golden regression fixture (009-13, spec 12 §12.6: "fixed fixture tenant, known-correct
 * values, asserted in CI. Any change altering these must be an explicit, reviewed decision.").
 *
 * One small, real, hand-derivable dataset — deliberately simple enough that every asserted metric
 * value in `golden.test.ts` can be checked by hand (this project's own standing rule: if you can't
 * verify a number by hand, it's too complex to trust as a fixture). Covers sales, cost, margin,
 * inventory, waste, and documents in one shared org/store, real rows through real repositories
 * (never raw inserts bypassing the domain layer, matching every prior catalog-entries.test.ts
 * fixture's own convention).
 *
 * Expected values (hand-derived, verified in `golden.test.ts`'s own comments too):
 * - Ingredient: base unit `each`. Supplier price $20.00 per 10-pack -> $2.00/each (real
 *   pack-to-base-unit division, not a fixture shortcut).
 * - Recipe: 1 each of the ingredient per batch, yield 1 -> recipe unit cost = $2.00.
 * - Lot: 100 units received @ $2.00 actual unit cost.
 * - 2 real sales transactions ($60.00 + $40.00 subtotal, both COMPLETED) selling 10 total units of
 *   the linked menu item.
 * - 10 units consumed via SALE_CONSUMPTION @ $2.00 actual cost = $20.00 actual COGS.
 * - 2 units wasted @ $2.00 = $4.00 waste value.
 * - 1 document at REVIEW_REQUIRED.
 */
export type GoldenFixture = {
  organizationId: string;
  storeId: string;
  productId: string;
  variantId: string;
  recipeGroupId: string;
  menuItemId: string;
  supplierProductId: string;
};

export const seedGoldenFixture = async (db: Db): Promise<GoldenFixture> => {
  const organizationId = generateId();
  await db.insert(organizations).values({
    id: organizationId,
    name: `Golden Regression Fixture ${organizationId}`,
    slug: `golden-fixture-${organizationId}`,
    baseCurrency: 'USD',
  });

  const storeId = generateId();
  await db.transaction((tx) =>
    withTenantContext(tx, organizationId, () =>
      tx.insert(stores).values({ id: storeId, organizationId, name: 'Golden Fixture Store', timezone: 'America/New_York' })
    )
  );

  const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
  const unitId = eachUnit!.id;

  const productId = generateId();
  const variantId = generateId();
  await db.transaction((tx) =>
    withTenantContext(tx, organizationId, async () => {
      await tx.insert(products).values({
        id: productId,
        organizationId,
        sku: `GOLDEN-${productId}`,
        name: 'Golden Fixture Ingredient',
        baseUnitId: unitId,
        type: 'INGREDIENT',
      });
      await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
    })
  );

  const supplierId = generateId();
  await db.transaction((tx) =>
    withTenantContext(tx, organizationId, () => tx.insert(suppliers).values({ id: supplierId, organizationId, name: 'Golden Fixture Supplier' }))
  );
  const supplierProductId = generateId();
  await db.transaction((tx) =>
    withTenantContext(tx, organizationId, () =>
      tx.insert(supplierProducts).values({
        id: supplierProductId,
        organizationId,
        supplierId,
        productId,
        supplierSku: 'GOLDEN-SKU-1',
        packSize: '10',
        packUnitId: unitId,
        conversionToBase: '10',
        isConfirmed: true,
      })
    )
  );
  const supplierPriceRepository = new SupplierPriceRepository(db, organizationId);
  await supplierPriceRepository.recordNewPrice({
    id: generateId(),
    supplierProductId,
    unitPrice: '20.0000', // $20.00 per 10-pack -> $2.00/each
    currency: 'USD',
    validFrom: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
  });

  const recipeGroupId = generateId();
  const recipeRepository = new RecipeRepository(db, organizationId);
  await recipeRepository.create({
    id: generateId(),
    recipeGroupId,
    name: 'Golden Fixture Recipe',
    yieldQuantity: '1',
    yieldUnitId: unitId,
    validFrom: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    components: [{ componentType: 'PRODUCT', productId, quantity: '1', unitId }],
  });

  const menuItemId = generateId();
  await db.transaction((tx) =>
    withTenantContext(tx, organizationId, () =>
      tx.insert(menuItems).values({
        id: menuItemId,
        organizationId,
        name: 'Golden Fixture Item',
        recipeGroupId,
        price: '10.0000',
        priceValidFrom: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      })
    )
  );

  const posItemId = generateId();
  await db.transaction((tx) =>
    withTenantContext(tx, organizationId, () =>
      tx.insert(posItems).values({
        id: posItemId,
        organizationId,
        storeId,
        source: 'square',
        externalId: `GOLDEN-POS-${posItemId}`,
        name: 'Golden Fixture Item',
        mappingStatus: 'MAPPED',
        menuItemId,
      })
    )
  );

  // Real lot: 100 units received @ $2.00 actual unit cost.
  const lotRepo = new LotRepository(db, organizationId);
  const lot = await lotRepo.receive({
    id: generateId(),
    storeId,
    productId,
    variantId,
    receivedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    initialQuantity: '100.000000',
    unitCost: '2.0000',
    currency: 'USD',
  });
  const movements = new MovementService(db, organizationId);
  await movements.postMovement({
    storeId,
    productId,
    variantId,
    lotId: lot.id,
    movementType: 'RECEIPT',
    quantity: '100.000000',
    unitCost: '2.0000',
    currency: 'USD',
    occurredAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    sourceType: 'golden-fixture',
  });

  // 2 real completed sales transactions selling 10 total units of the menu item.
  const salesRepo = new SalesTransactionRepository(db, organizationId);
  await salesRepo.recordIfNew({
    storeId,
    source: 'square',
    externalId: `GOLDEN-SALE-A-${organizationId}`,
    occurredAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    subtotal: '60.0000',
    discount: '0.0000',
    tax: '0.0000',
    total: '60.0000',
    currency: 'USD',
    lines: [{ posItemId, quantity: '6.000000', unitPrice: '10.0000', discount: '0.0000', lineTotal: '60.0000' }],
  });
  await salesRepo.recordIfNew({
    storeId,
    source: 'square',
    externalId: `GOLDEN-SALE-B-${organizationId}`,
    occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    subtotal: '40.0000',
    discount: '0.0000',
    tax: '0.0000',
    total: '40.0000',
    currency: 'USD',
    lines: [{ posItemId, quantity: '4.000000', unitPrice: '10.0000', discount: '0.0000', lineTotal: '40.0000' }],
  });

  // 10 units consumed via SALE_CONSUMPTION @ $2.00 actual cost — `consumeFefo`, not a raw
  // `postMovement`, since only the FEFO-allocating methods (`consumeFefo`/`logWaste`) draw down
  // `lots.remaining_quantity` in the same transaction as the ledger row. A plain `postMovement`
  // call posts the movement and updates `stock_levels` but leaves `lots.remaining_quantity`
  // untouched — confirmed the hard way: `stock_value` (which reads `lots.remaining_quantity`
  // directly) initially showed the full pre-consumption value until this was fixed.
  await movements.consumeFefo({
    storeId,
    productId,
    variantId,
    requiredQuantity: '10.000000',
    unit: 'each',
    occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    sourceType: 'golden-fixture',
  });

  // 2 units wasted @ $2.00 — same reasoning, `logWaste` not a raw `postMovement`.
  await movements.logWaste({
    storeId,
    productId,
    variantId,
    quantity: '2.000000',
    unit: 'each',
    reasonCode: 'SPILLAGE',
    occurredAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    sourceType: 'golden-fixture',
  });

  // 1 document awaiting review.
  await db.transaction((tx) =>
    withTenantContext(tx, organizationId, () =>
      tx.insert(documents).values({
        id: generateId(),
        organizationId,
        storeId,
        type: 'INVOICE',
        source: 'UPLOAD',
        status: 'REVIEW_REQUIRED',
        storageKey: `${organizationId}/golden-fixture.pdf`,
        contentHash: `golden-fixture-${generateId()}`,
        mimeType: 'application/pdf',
        sizeBytes: 1,
      })
    )
  );

  return { organizationId, storeId, productId, variantId, recipeGroupId, menuItemId, supplierProductId };
};
