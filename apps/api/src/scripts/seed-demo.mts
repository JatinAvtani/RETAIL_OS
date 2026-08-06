/**
 * Seeds a realistic demo tenant so the UI has something meaningful to show.
 *
 * This is DEMO data, not the project's eventual full mock corpus — that stays a single deliberate
 * generation pass once every epic's data shape is settled. This script covers only the domains
 * that genuinely exist today (catalog, suppliers/prices, recipes, inventory, POS sales) and
 * deliberately writes through the REAL repositories and services rather than raw inserts, so the
 * seeded state is reachable by the same code paths the app itself uses — a stock level here is a
 * real projection of real ledger movements, not a hand-written number.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @retailos/api exec tsx src/scripts/seed-demo.mts <email>
 *
 * The email must belong to an existing, verified user (sign up through the app first). The script
 * creates a fresh organization and store for that user each run, so repeated runs never collide.
 */
import {
  createDb,
  units,
  users,
  organizations,
  stores,
  memberships,
  CategoryRepository,
  ProductRepository,
  StorageLocationRepository,
  SupplierRepository,
  SupplierProductRepository,
  SupplierPriceRepository,
  RecipeRepository,
  MenuItemRepository,
  LotRepository,
  MovementService,
  PosItemRepository,
  SalesTransactionRepository,
  SalesIngestionPipeline,
} from '@retailos/db';
import { generateId } from '@retailos/domain';
import { eq } from 'drizzle-orm';
import Decimal from 'decimal.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: tsx src/scripts/seed-demo.mts <email-of-existing-verified-user>');
  process.exit(1);
}

const { db } = createDb(process.env.DATABASE_URL!);

const [user] = await db.select().from(users).where(eq(users.email, email));
if (!user) {
  console.error(`No user found for ${email}. Sign up through the app first, then re-run.`);
  process.exit(1);
}

const unitRows = await db.select().from(units);
const unitByCode = new Map(unitRows.map((u) => [u.code, u.id]));
const gram = unitByCode.get('g');
const kilogram = unitByCode.get('kg');
const each = unitByCode.get('each');
const millilitre = unitByCode.get('ml');
if (!gram || !kilogram || !each || !millilitre) {
  console.error('Base units are missing — run migrations first.');
  process.exit(1);
}

/* ------------------------------------------------------------------ org, store, membership */

const organizationId = generateId();
await db.insert(organizations).values({
  id: organizationId,
  name: 'Ardent Bakehouse',
  slug: `ardent-bakehouse-${organizationId}`,
  baseCurrency: 'USD',
});

const storeId = generateId();
await db.insert(stores).values({
  id: storeId,
  organizationId,
  name: 'Mill Street',
  timezone: 'America/New_York',
});

await db.insert(memberships).values({
  id: generateId(),
  organizationId,
  userId: user.id,
  role: 'OWNER',
  storeIds: [storeId],
  approvalLimit: '10000.0000',
  acceptedAt: new Date(),
});

/* ------------------------------------------------------------------ catalog */

const categoryRepo = new CategoryRepository(db, organizationId);
const productRepo = new ProductRepository(db, organizationId);
const locationRepo = new StorageLocationRepository(db, organizationId);

const dryGoods = await categoryRepo.create({ id: generateId(), name: 'Dry goods' });
const dairy = await categoryRepo.create({ id: generateId(), name: 'Dairy' });
const beverage = await categoryRepo.create({ id: generateId(), name: 'Beverage' });

const dryStore = await locationRepo.create({ id: generateId(), storeId, name: 'Dry store' });
const walkIn = await locationRepo.create({ id: generateId(), storeId, name: 'Walk-in fridge' });

type SeedProduct = {
  sku: string;
  name: string;
  unitId: string;
  /** The domain-level unit code, needed by movement/waste APIs which take a `Unit`, not a unit id. */
  unitCode: 'g' | 'ml' | 'each';
  categoryId: string;
  locationId: string;
  perishable: boolean;
  /** Supplier pack price and how many base units one pack contains. */
  packPrice: string;
  packSize: string;
  conversionToBase: string;
  openingQty: string;
  unitCost: string;
  expiryInDays?: number;
};

const seedProducts: SeedProduct[] = [
  // Opening quantities are sized to sustain the full two weeks of seeded sales below without
  // running dry — a mid-period stockout would silently truncate consumption and make food cost
  // percentage read far lower than reality.
  { sku: 'FLR-00', name: 'Flour, type 00', unitId: gram, unitCode: 'g', categoryId: dryGoods.id, locationId: dryStore.id, perishable: false, packPrice: '24.00', packSize: '25', conversionToBase: '25000', openingQty: '400000', unitCost: '0.0010' },
  { sku: 'BTR-UNS', name: 'Butter, unsalted', unitId: gram, unitCode: 'g', categoryId: dairy.id, locationId: walkIn.id, perishable: true, packPrice: '38.50', packSize: '5', conversionToBase: '5000', openingQty: '120000', unitCost: '0.0077', expiryInDays: 21 },
  { sku: 'SGR-CST', name: 'Caster sugar', unitId: gram, unitCode: 'g', categoryId: dryGoods.id, locationId: dryStore.id, perishable: false, packPrice: '18.00', packSize: '10', conversionToBase: '10000', openingQty: '60000', unitCost: '0.0018' },
  { sku: 'EGG-LRG', name: 'Eggs, large', unitId: each, unitCode: 'each', categoryId: dairy.id, locationId: walkIn.id, perishable: true, packPrice: '9.60', packSize: '60', conversionToBase: '60', openingQty: '600', unitCost: '0.1600', expiryInDays: 12 },
  { sku: 'MLK-WHL', name: 'Milk, whole', unitId: millilitre, unitCode: 'ml', categoryId: dairy.id, locationId: walkIn.id, perishable: true, packPrice: '14.40', packSize: '12', conversionToBase: '12000', openingQty: '90000', unitCost: '0.0012', expiryInDays: 6 },
  { sku: 'CFE-ESP', name: 'Espresso beans', unitId: gram, unitCode: 'g', categoryId: beverage.id, locationId: dryStore.id, perishable: false, packPrice: '46.00', packSize: '2', conversionToBase: '2000', openingQty: '24000', unitCost: '0.0230' },
  { sku: 'SLT-SEA', name: 'Sea salt', unitId: gram, unitCode: 'g', categoryId: dryGoods.id, locationId: dryStore.id, perishable: false, packPrice: '6.50', packSize: '2', conversionToBase: '2000', openingQty: '8000', unitCost: '0.0033' },
  { sku: 'YST-FRS', name: 'Fresh yeast', unitId: gram, unitCode: 'g', categoryId: dryGoods.id, locationId: walkIn.id, perishable: true, packPrice: '11.20', packSize: '1', conversionToBase: '1000', openingQty: '5000', unitCost: '0.0112', expiryInDays: 4 },
];

const created = new Map<string, { id: string; variantId: string; unitId: string }>();
for (const p of seedProducts) {
  const product = await productRepo.create({
    id: generateId(),
    sku: p.sku,
    name: p.name,
    baseUnitId: p.unitId,
    type: 'INGREDIENT',
    categoryId: p.categoryId,
    isPerishable: p.perishable,
  });
  // No repository path assigns a storage location yet (neither `create` nor `update` accepts one),
  // so products stay unassigned here rather than reaching around the repository layer with a raw
  // insert. The stocktake sheet renders these as "Unassigned", which is honest.
  const variants = await productRepo.findVariants(product.id);
  created.set(p.sku, { id: product.id, variantId: variants[0]!.id, unitId: p.unitId });
}

/* ------------------------------------------------------------------ suppliers + confirmed prices */

const supplierRepo = new SupplierRepository(db, organizationId);
const supplierProductRepo = new SupplierProductRepository(db, organizationId);
const supplierPriceRepo = new SupplierPriceRepository(db, organizationId);

const millers = await supplierRepo.create({
  id: generateId(),
  name: 'Northgate Millers',
  paymentTerms: 'NET30',
  leadTimeDaysContracted: 3,
});
const creamery = await supplierRepo.create({
  id: generateId(),
  name: 'Hollow Creek Creamery',
  paymentTerms: 'NET14',
  leadTimeDaysContracted: 2,
});

const supplierFor = (sku: string) =>
  ['BTR-UNS', 'EGG-LRG', 'MLK-WHL'].includes(sku) ? creamery.id : millers.id;

for (const p of seedProducts) {
  const product = created.get(p.sku)!;
  const link = await supplierProductRepo.create({
    id: generateId(),
    supplierId: supplierFor(p.sku),
    productId: product.id,
    supplierSku: `${p.sku}-PACK`,
    packSize: p.packSize,
    packUnitId: p.unitId,
    conversionToBase: p.conversionToBase,
  });
  // Every mapping is confirmed, so recipe costs and therefore theoretical COGS genuinely resolve
  // — cost variance is the dashboard's headline number and needs both sides known to exist at all.
  // The "unknown, never zero" behaviour is still demonstrated elsewhere and honestly: an
  // additional unpriced product is created below with no supplier mapping at all.
  await supplierProductRepo.confirm(link.id);
  await supplierPriceRepo.recordNewPrice({
    id: generateId(),
    supplierProductId: link.id,
    unitPrice: p.packPrice,
    currency: 'USD',
    validFrom: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
  });
}

/**
 * A product with NO supplier mapping at all — a genuinely unpriced ingredient, the everyday case
 * where someone adds an item to the catalog before anyone records what it costs. The recipe using
 * it below therefore reports its cost as unknown rather than as a number, which is the behaviour
 * worth demonstrating: a missing cost must never quietly become zero, because a zero cost reads as
 * pure profit.
 */
const unpricedProduct = await productRepo.create({
  id: generateId(),
  sku: 'VAN-POD',
  name: 'Vanilla pods',
  baseUnitId: each,
  type: 'INGREDIENT',
  categoryId: dryGoods.id,
  isPerishable: false,
});
const unpricedVariants = await productRepo.findVariants(unpricedProduct.id);
created.set('VAN-POD', {
  id: unpricedProduct.id,
  variantId: unpricedVariants[0]!.id,
  unitId: each,
});

/* ------------------------------------------------------------------ opening stock (real ledger) */

const lotRepo = new LotRepository(db, organizationId);
const movements = new MovementService(db, organizationId);

for (const p of seedProducts) {
  const product = created.get(p.sku)!;
  const lot = await lotRepo.receive({
    id: generateId(),
    storeId,
    productId: product.id,
    variantId: product.variantId,
    lotNumber: `${p.sku}-L1`,
    receivedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    initialQuantity: p.openingQty,
    unitCost: p.unitCost,
    currency: 'USD',
    ...(p.expiryInDays !== undefined
      ? { expiryDate: new Date(Date.now() + p.expiryInDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) }
      : {}),
  });

  await movements.postMovement({
    storeId,
    productId: product.id,
    variantId: product.variantId,
    lotId: lot.id,
    movementType: 'RECEIPT',
    quantity: p.openingQty,
    unitCost: p.unitCost,
    currency: 'USD',
    occurredAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    sourceType: 'demo-seed',
    actorUserId: user.id,
  });
}

/* ------------------------------------------------------------------ a little real waste */

await movements.logWaste({
  storeId,
  productId: created.get('MLK-WHL')!.id,
  variantId: created.get('MLK-WHL')!.variantId,
  quantity: '750',
  unit: 'ml',
  occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  sourceType: 'demo-seed',
  reasonCode: 'SPILLAGE',
  actorUserId: user.id,
});

await movements.logWaste({
  storeId,
  productId: created.get('BTR-UNS')!.id,
  variantId: created.get('BTR-UNS')!.variantId,
  quantity: '400',
  unit: 'g',
  occurredAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
  sourceType: 'demo-seed',
  reasonCode: 'PREP_ERROR',
  actorUserId: user.id,
});

/* ------------------------------------------------------------------ recipes + menu items */

const recipeRepo = new RecipeRepository(db, organizationId);
const menuItemRepo = new MenuItemRepository(db, organizationId);

const recipeSpecs = [
  {
    name: 'Sourdough loaf',
    yieldQuantity: '1',
    yieldUnitId: each,
    price: '8.50',
    components: [
      { sku: 'FLR-00', quantity: '500', unitId: gram },
      { sku: 'SLT-SEA', quantity: '10', unitId: gram },
      { sku: 'YST-FRS', quantity: '7', unitId: gram },
    ],
  },
  {
    name: 'Butter croissant',
    yieldQuantity: '12',
    yieldUnitId: each,
    price: '4.25',
    components: [
      { sku: 'FLR-00', quantity: '1000', unitId: gram },
      { sku: 'BTR-UNS', quantity: '600', unitId: gram },
      { sku: 'SGR-CST', quantity: '80', unitId: gram },
      { sku: 'MLK-WHL', quantity: '250', unitId: millilitre },
    ],
  },
  {
    name: 'Flat white',
    yieldQuantity: '1',
    yieldUnitId: each,
    price: '4.75',
    components: [
      { sku: 'CFE-ESP', quantity: '18', unitId: gram },
      { sku: 'MLK-WHL', quantity: '150', unitId: millilitre },
    ],
  },
  {
    name: 'Vanilla custard tart',
    yieldQuantity: '8',
    yieldUnitId: each,
    price: '5.50',
    components: [
      { sku: 'FLR-00', quantity: '300', unitId: gram },
      { sku: 'BTR-UNS', quantity: '150', unitId: gram },
      { sku: 'EGG-LRG', quantity: '6', unitId: each },
      { sku: 'MLK-WHL', quantity: '500', unitId: millilitre },
      { sku: 'SGR-CST', quantity: '120', unitId: gram },
    ],
  },
  {
    // Uses the unpriced vanilla pod, so this recipe's cost genuinely resolves to "unknown" on the
    // recipe detail page. Deliberately NOT sold through the POS below — an unknown-cost item in
    // the sales mix would make the whole period's theoretical COGS unknown, correctly but
    // unhelpfully, hiding the cost-variance feature behind a single unpriced ingredient.
    name: 'Vanilla bean custard (prep)',
    yieldQuantity: '10',
    yieldUnitId: each,
    price: '6.00',
    components: [
      { sku: 'MLK-WHL', quantity: '800', unitId: millilitre },
      { sku: 'EGG-LRG', quantity: '8', unitId: each },
      { sku: 'SGR-CST', quantity: '150', unitId: gram },
      { sku: 'VAN-POD', quantity: '2', unitId: each },
    ],
  },
];

const menuItems: Array<{ id: string; name: string }> = [];
for (const spec of recipeSpecs) {
  const recipeGroupId = generateId();
  const recipe = await recipeRepo.create({
    id: generateId(),
    recipeGroupId,
    name: spec.name,
    yieldQuantity: spec.yieldQuantity,
    yieldUnitId: spec.yieldUnitId,
    validFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    components: spec.components.map((c) => ({
      componentType: 'PRODUCT' as const,
      productId: created.get(c.sku)!.id,
      quantity: c.quantity,
      unitId: c.unitId,
    })),
  });
  void recipe;

  const menuItem = await menuItemRepo.create({
    id: generateId(),
    name: spec.name,
    recipeGroupId,
    price: spec.price,
    priceValidFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  });
  menuItems.push({ id: menuItem.id, name: menuItem.name });
}

/* ------------------------------------------------------------------ POS catalog + real sales */

const posItemRepo = new PosItemRepository(db, organizationId);
const salesRepo = new SalesTransactionRepository(db, organizationId);

/** Names deliberately don't match menu items exactly — that's the real mapping problem the
 *  POS-mapping screen exists to solve, and it makes the fuzzy suggestions meaningful. */
const posCatalog = [
  { externalId: 'SQ-1001', name: 'Sourdough Loaf', mapTo: 'Sourdough loaf', unitPrice: '8.50', sold: 46 },
  { externalId: 'SQ-1002', name: 'Croissant - Butter', mapTo: 'Butter croissant', unitPrice: '4.25', sold: 118 },
  { externalId: 'SQ-1003', name: 'Flat White', mapTo: 'Flat white', unitPrice: '4.75', sold: 204 },
  { externalId: 'SQ-1004', name: 'Custard Tart (Vanilla)', mapTo: null, unitPrice: '5.50', sold: 37 },
  { externalId: 'SQ-1005', name: 'Gift Card $25', mapTo: null, unitPrice: '25.00', sold: 4 },
  { externalId: 'SQ-1006', name: 'Oat Milk Surcharge', mapTo: null, unitPrice: '0.75', sold: 61 },
];

const menuItemByName = new Map(menuItems.map((m) => [m.name, m.id]));

const posItemIds = new Map<string, string>();
for (const item of posCatalog) {
  const posItem = await posItemRepo.upsert({
    id: generateId(),
    storeId,
    source: 'square',
    externalId: item.externalId,
    name: item.name,
    price: item.unitPrice,
    currency: 'USD',
  });
  posItemIds.set(item.externalId, posItem.id);

  if (item.mapTo) {
    await posItemRepo.mapToMenuItem(posItem.id, menuItemByName.get(item.mapTo)!);
  }
}

/**
 * Sales are written as one transaction per day per item across the trailing two weeks. Critically,
 * the SAME per-day quantities drive both the recorded revenue here and the consumption triggered
 * below — if revenue covered the full volume while consumption only ran for part of it, food cost
 * percentage would come out implausibly low for reasons that have nothing to do with the business.
 */
const SALES_DAYS = 14;
/** `unitsSold` is a whole-unit count kept as a Decimal so every line total below stays exact decimal arithmetic — never a float multiplication against a price. */
type DailySale = { externalId: string; day: number; unitsSold: Decimal; occurredAt: Date };
const dailySales: DailySale[] = [];

for (const item of posCatalog) {
  const perDay = Decimal.max(1, new Decimal(item.sold).dividedBy(SALES_DAYS).floor());
  for (let dayOffset = SALES_DAYS; dayOffset >= 1; dayOffset--) {
    dailySales.push({
      externalId: item.externalId,
      day: dayOffset,
      unitsSold: perDay,
      occurredAt: new Date(Date.now() - dayOffset * 24 * 60 * 60 * 1000),
    });
  }
}

for (const sale of dailySales) {
  const item = posCatalog.find((c) => c.externalId === sale.externalId)!;
  const lineTotal = new Decimal(item.unitPrice).times(sale.unitsSold).toFixed(4);
  await salesRepo.recordIfNew({
    storeId,
    source: 'square',
    externalId: `SQ-ORDER-${sale.externalId}-D${sale.day}`,
    occurredAt: sale.occurredAt,
    subtotal: lineTotal,
    discount: '0.0000',
    tax: '0.0000',
    total: lineTotal,
    currency: 'USD',
    lines: [
      {
        posItemId: posItemIds.get(sale.externalId)!,
        quantity: sale.unitsSold.toFixed(6),
        unitPrice: item.unitPrice,
        discount: '0.0000',
        lineTotal,
      },
    ],
  });
}

/* ------------------------------------------------------------------ trigger real consumption */

/**
 * Runs the same ingestion pipeline a real POS sync would: for every mapped sale line, explode the
 * recipe and FEFO-consume the ingredients, posting real SALE_CONSUMPTION movements at the actual
 * cost of the lots drawn from. Without this the dashboard's actual COGS would be zero — and a zero
 * COGS reads as 100% margin, exactly the fabricated-looking number the whole design prevents.
 *
 * Sales are spread across the trailing two weeks so the dashboard's period filters show movement
 * rather than one spike.
 */
const pipeline = new SalesIngestionPipeline(db, organizationId);
let consumedLines = 0;
let otherOutcomes = 0;

// Walks the exact same daily sale events that produced the revenue above, so actual COGS and net
// revenue describe the same sales — the only way food cost percentage means anything.
for (const sale of dailySales) {
  const item = posCatalog.find((c) => c.externalId === sale.externalId)!;
  const result = await pipeline.ingestSaleLine({
    storeId,
    // An unmapped item goes to quarantine rather than consuming anything — the real branch, kept
    // deliberately so the dashboard's completeness panel has genuine unmapped volume to report.
    menuItemId: item.mapTo ? menuItemByName.get(item.mapTo)! : null,
    posItemExternalId: item.externalId,
    posItemName: item.name,
    quantitySold: sale.unitsSold.toFixed(6),
    revenue: new Decimal(item.unitPrice).times(sale.unitsSold).toFixed(4),
    currency: 'USD',
    occurredAt: sale.occurredAt,
    sourceType: 'demo-seed',
    actorUserId: user.id,
  });
  if (result.status === 'consumed') consumedLines += 1;
  else otherOutcomes += 1;
}

console.log(
  JSON.stringify(
    {
      organization: 'Ardent Bakehouse',
      consumedLines,
      otherOutcomes,
      organizationId,
      storeId,
      products: seedProducts.length,
      recipes: recipeSpecs.length,
      posItems: posCatalog.length,
      unmappedPosItems: posCatalog.filter((p) => !p.mapTo).length,
      signInAs: email,
    },
    null,
    2
  )
);
process.exit(0);
