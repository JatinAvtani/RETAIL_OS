// Loads .env.local so this script runs straight from a fresh clone (see load-env.ts).
import '@retailos/config/auto';
/**
 * Seeds the demo tenant by READING the generated Indian corpus in `mock-data/`.
 *
 * This script holds NO business data of its own. Every product, price, recipe, supplier and sale
 * comes from `mock-data/`, which is produced by the deterministic generator in
 * `mock-data/generate/`. That split is the point: the corpus is browsable and reviewable as plain
 * JSON before a single row is written, and a fresh clone reproduces it byte-identically from the
 * committed generator. A seed script that also invents its own numbers cannot offer either.
 *
 * Everything is written THROUGH THE REAL REPOSITORIES AND SERVICES, never raw inserts. A stock level
 * here is a genuine projection of genuine ledger movements; a recipe cost genuinely resolves (or
 * genuinely does not — see the unpriced product) through the same code paths the app itself uses. A
 * demo built on raw inserts proves only that rows can be inserted.
 *
 * IDEMPOTENT: re-running WIPES the demo organization and rebuilds it, so the demo never accumulates
 * duplicate history across runs. The delete order is derived from `pg_constraint` at runtime by
 * `wipe-organization.mts` — see that file for the genuine FK cycle it has to break.
 *
 * The demo LOGIN IS PRESERVED across re-seeds: the user row is never deleted, only its membership
 * and the organization beneath it. A real "Explore demo" button depends on that account existing.
 *
 * Usage:
 *   DATABASE_URL=... REDIS_URL=... pnpm --filter @retailos/api exec tsx src/scripts/seed-demo.mts
 *
 * Flags:
 *   --dry-run                         report what would be seeded, write nothing
 *   --skip-wipe                       add to the existing org instead of rebuilding (debugging only)
 *   --limit-days=N                    include only sales from the most recent N days
 *   --max-receipts-per-store-day=N    deterministically cap receipt volume for a fast demo
 */
import { readFileSync } from 'node:fs';
import { Decimal } from 'decimal.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import type { CurrencyCode } from '@retailos/domain';
import { eq } from 'drizzle-orm';
import { createQueueRedisConnection, createFactAggregationQueue, registerFactAggregationJob } from '@retailos/queue';
// `.mjs`, not `.mts`: this package emits real `.mjs` output, so the built specifier must match, and
// tsx resolves `.mjs` back to the `.mts` source when running from source. Verified both ways.
import { wipeOrganization } from './wipe-organization.mjs';
import {
  capReceiptsPerStoreDay,
  isWithinDemoWindow,
  parseDemoSeedOptions,
} from './demo-seed-options.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_WIPE = process.argv.includes('--skip-wipe');
/**
 * `--limit-days=N` seeds only the most recent N days of sales. Every sale line runs the real
 * ingestion pipeline (recipe explosion -> FEFO draw -> movement posting) in its own transaction, so
 * a full window is ~148k sequential round-trips. This flag exists to MEASURE that rate on a real
 * slice rather than guess at it, and to give a usable demo quickly on a constrained machine.
 * Catalog, suppliers and stock are always seeded in full — only the sales window is narrowed.
 */
const { limitDays: LIMIT_DAYS, maxReceiptsPerStoreDay: MAX_RECEIPTS_PER_STORE_DAY } =
  parseDemoSeedOptions(process.argv.slice(2));

/* ------------------------------------------------------------------ corpus */

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '../../../../mock-data');
// The trailing comma in `<T,>` is required: in a .mts file a bare `<T>` arrow generic is reserved
// syntax (it parses as JSX), which is a compile error rather than a style preference.
const read = <T,>(relative: string): T => JSON.parse(readFileSync(join(CORPUS, relative), 'utf8')) as T;

interface CorpusMeta {
  seed: number;
  generatedAt: string;
  organization: { name: string; slug: string; baseCurrency: string };
  stores: { code: string; name: string; address: string; timezone: string; role: string; opensDaysAgo: number }[];
  staff: { email: string; name: string; role: 'OWNER' | 'MANAGER'; storeCode: string | null; approvalLimit?: string }[];
  historyDays: number;
  receiptLevelDays: number;
}
interface CorpusProduct {
  sku: string; name: string; unitCode: 'g' | 'ml' | 'each'; category: string; storageLocation: string;
  perishable: boolean; packPrice: string; packLabel: string; conversionToBase: string; unitCost: string;
  hsn: string; gstBasisPoints: number; expiryInDays?: number; deliberatelyUnpriced?: boolean;
}
interface CorpusMenuItem {
  name: string; posName: string; yieldQuantity: string; yieldUnitCode: 'g' | 'ml' | 'each';
  price: string; flagshipPerDay: number; components: { sku: string; quantity: string }[];
}
interface CorpusSupplier {
  code: string; name: string; gstin: string; address: string; paymentTerms: string; leadTimeDays: number;
}
interface CorpusSupplierProduct {
  supplierCode: string; sku: string; supplierSku: string; packLabel: string; packSize: string;
  conversionToBase: string; basePackPrice: string; confirmed: boolean;
}
interface CorpusPosItems {
  fromMenu: { externalId: string; posName: string; menuItemName: string; price: string }[];
  nonMenu: { externalId: string; name: string; price: string }[];
}
interface CorpusReceipt {
  externalId: string; storeCode: string; occurredAt: string; daysAgo: number;
  lines: { externalId: string; posName: string; qty: number; unitPrice: string; lineTotal: string }[];
  subtotal: string; discount: string; cgst: string; sgst: string; total: string;
  paymentMode: string; status: 'COMPLETED' | 'VOIDED';
}
interface CorpusAggregate {
  storeCode: string; date: string; daysAgo: number;
  items: { externalId: string; posName: string; units: number; unitPrice: string }[];
}

const meta = read<CorpusMeta>('meta.json');
const categories = read<{ name: string }[]>('catalog/categories.json');
const products = read<CorpusProduct[]>('catalog/products.json');
const menuItemSpecs = read<CorpusMenuItem[]>('catalog/menu-items.json');
const posItemsSpec = read<CorpusPosItems>('catalog/pos-items.json');
const supplierSpecs = read<CorpusSupplier[]>('suppliers/suppliers.json');
const supplierProducts = read<CorpusSupplierProduct[]>('suppliers/supplier-products.json');
/**
 * Filtered ONCE, here, so replenishment sizing and the sales actually written are derived from the
 * same set. Sizing stock against the full window while seeding only part of it would leave every
 * lot massively overstocked and make stock-on-hand meaningless.
 */
const withinWindow = (daysAgo: number): boolean => isWithinDemoWindow(daysAgo, LIMIT_DAYS);

const aggregates = read<CorpusAggregate[]>('sales/daily-aggregates.json').filter((a) => withinWindow(a.daysAgo));

/**
 * Receipts are loaded ONE STORE AT A TIME, never all at once.
 *
 * The three receipt files are 28 MB of JSON, which becomes several hundred MB once parsed into JS
 * objects — and this run holds them for hours while writing ~50k transactions. Free RAM on this
 * machine has been measured under 1 GB, and it has previously OOM'd hard enough to kill Docker
 * Desktop. Holding one store's receipts at a time caps the resident set at roughly the largest
 * single file instead of the sum of all three.
 *
 * The two passes that need receipts (demand sizing, then seeding) each call this and let the array
 * go out of scope, so at most one store's worth is reachable at any moment.
 */
const loadReceipts = (storeCode: string): CorpusReceipt[] =>
  capReceiptsPerStoreDay(
    read<CorpusReceipt[]>(`sales/receipts-${storeCode.toLowerCase()}.json`).filter((r) => withinWindow(r.daysAgo)),
    MAX_RECEIPTS_PER_STORE_DAY
  );

/** Counted without retaining the receipts themselves — used only for the dry-run report. */
const countReceipts = (): { receipts: number; lines: number } => {
  let receipts = 0;
  let lines = 0;
  for (const store of meta.stores) {
    const batch = loadReceipts(store.code);
    receipts += batch.length;
    lines += batch.reduce((n, r) => n + r.lines.length, 0);
  }
  return { receipts, lines };
};

/**
 * Validated at the boundary rather than cast. The corpus is plain JSON, so its currency arrives as a
 * bare string; asserting it into the branded union would defeat the exact protection that type
 * exists for. A corpus naming an unsupported currency must fail here, loudly, not surface later as
 * money arithmetic in a currency nothing else understands.
 */
const SUPPORTED_CURRENCIES: CurrencyCode[] = ['USD', 'EUR', 'GBP', 'INR'];
const isCurrencyCode = (value: string): value is CurrencyCode =>
  (SUPPORTED_CURRENCIES as string[]).includes(value);

if (!isCurrencyCode(meta.organization.baseCurrency)) {
  console.error(
    `Corpus base currency "${meta.organization.baseCurrency}" is not a supported CurrencyCode ` +
      `(${SUPPORTED_CURRENCIES.join(', ')}).`
  );
  process.exit(1);
}
const CURRENCY: CurrencyCode = meta.organization.baseCurrency;

/* ------------------------------------------------------------------ connect */

const { db, client } = createDb(process.env.DATABASE_URL!);

/**
 * The corpus is plain JSON, so its shape is UNCHECKED by the compiler — the declared interfaces
 * above are a claim, not a guarantee. A missing field arrives as `undefined`, sails through every
 * type check, and surfaces hundreds of rows later as a NOT NULL violation far from its cause (which
 * is exactly what happened: `meta.json` was projecting `timezone` away, and the seed died on the
 * first store insert). Asserting the fields actually needed, up front, turns that into one clear
 * error before anything is written.
 */
const requireFields = (label: string, object: Record<string, unknown>, fields: string[]): void => {
  const missing = fields.filter((f) => object[f] === undefined || object[f] === null);
  if (missing.length > 0) {
    console.error(
      `Corpus ${label} is missing required field(s): ${missing.join(', ')}. ` +
        'Regenerate the corpus (mock-data/generate/generate.mts) — the reader cannot invent these.'
    );
    process.exit(1);
  }
};

requireFields('meta.organization', meta.organization as unknown as Record<string, unknown>, ['name', 'slug', 'baseCurrency']);
for (const store of meta.stores) {
  // `storeCode: null` is legitimate for an all-stores OWNER, so nullable fields are not asserted.
  requireFields(`store ${store.code}`, store as unknown as Record<string, unknown>, ['code', 'name', 'timezone', 'opensDaysAgo']);
}
for (const person of meta.staff) {
  requireFields(`staff ${person.email}`, person as unknown as Record<string, unknown>, ['email', 'role']);
}

const owner = meta.staff.find((s) => s.role === 'OWNER');
if (!owner) throw new Error('Corpus defines no OWNER — refusing to seed a tenant nobody can sign into.');

const [demoUser] = await db.select().from(users).where(eq(users.email, owner.email));
if (!demoUser) {
  // The demo login is a product feature, not an implementation detail — a real "Explore demo" button
  // depends on it. Creating the user here would mean inventing a password hash, so this fails loudly
  // with the exact remedy instead of silently seeding a tenant nobody can reach.
  console.error(
    `No user found for ${owner.email}. Sign that account up through the app first (or run the ` +
      'auth seed), then re-run — this script never creates credentials.'
  );
  process.exit(1);
}

const unitRows = await db.select().from(units);
const unitByCode = new Map(unitRows.map((u) => [u.code, u.id]));
for (const code of ['g', 'ml', 'each', 'kg']) {
  if (!unitByCode.get(code)) {
    console.error(`Base unit "${code}" is missing — run migrations first.`);
    process.exit(1);
  }
}
const unitIdFor = (code: string): string => unitByCode.get(code)!;

if (DRY_RUN) {
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        corpusSeed: meta.seed,
        generatedAt: meta.generatedAt,
        profile: {
          limitDays: LIMIT_DAYS,
          maxReceiptsPerStoreDay: MAX_RECEIPTS_PER_STORE_DAY,
        },
        wouldSeed: {
          organization: meta.organization.name,
          stores: meta.stores.length,
          staff: meta.staff.length,
          categories: categories.length,
          products: products.length,
          menuItems: menuItemSpecs.length,
          suppliers: supplierSpecs.length,
          supplierProducts: supplierProducts.length,
          posItems: posItemsSpec.fromMenu.length + posItemsSpec.nonMenu.length,
          dailyAggregates: aggregates.length,
          ...countReceipts(),
        },
      },
      null,
      2
    )
  );
  await client.end();
  process.exit(0);
}

/* ------------------------------------------------------------------ wipe + org */

const started = Date.now();
const log = (stage: string, detail?: unknown) =>
  console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s] ${stage}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);

/**
 * Existing demo orgs are found TWO ways, and both are needed:
 *
 *  - by the OWNER's membership, so a renamed org is still found and replaced;
 *  - by the corpus slug, which catches an ORPHANED org from a run that died after creating the
 *    organization but before creating the membership. Membership-only lookup cannot see those, and
 *    they then block the next run forever on the slug unique constraint. (This is not hypothetical —
 *    it happened on the first real run here.)
 */
const byMembership = await db
  .select({ organizationId: memberships.organizationId })
  .from(memberships)
  .where(eq(memberships.userId, demoUser.id));

const bySlug = await db
  .select({ organizationId: organizations.id })
  .from(organizations)
  .where(eq(organizations.slug, meta.organization.slug));

const existing = [...new Map([...byMembership, ...bySlug].map((r) => [r.organizationId, r])).values()];

if (!SKIP_WIPE) {
  for (const row of existing) {
    const result = await wipeOrganization(db, row.organizationId, {});
    const removed = Object.entries(result.deleted).filter(([, n]) => n > 0);
    log('wiped org', { organizationId: row.organizationId, tables: removed.length, rows: removed.reduce((n, [, v]) => n + v, 0) });
    // The organization row itself is outside the wipe's scope (it is the anchor every predicate
    // filters on), so it is removed last, here, once everything beneath it is gone.
    await db.delete(organizations).where(eq(organizations.id, row.organizationId));
  }
} else {
  log('skip-wipe', { existingOrgs: existing.length });
}

const organizationId = generateId();
await db.insert(organizations).values({
  id: organizationId,
  name: meta.organization.name,
  slug: meta.organization.slug,
  baseCurrency: meta.organization.baseCurrency,
});

const storeIdByCode = new Map<string, string>();
const factConnection = createQueueRedisConnection(process.env.REDIS_URL ?? 'redis://localhost:6379');
const factQueue = createFactAggregationQueue(factConnection);
for (const store of meta.stores) {
  const storeId = generateId();
  await db.insert(stores).values({
    id: storeId,
    organizationId,
    name: store.name,
    timezone: store.timezone,
  });
  storeIdByCode.set(store.code, storeId);
  // Store creation is still the only real trigger point for the daily fact-aggregation job.
  await registerFactAggregationJob(factQueue, { organizationId, storeId, storeTimezone: store.timezone });
}
await factQueue.close();
await factConnection.quit();

for (const person of meta.staff) {
  const [row] = await db.select().from(users).where(eq(users.email, person.email));
  if (!row) {
    // A missing non-owner is a gap in the demo, not a reason to abort a seed that is otherwise fine.
    log('staff skipped (no user row)', { email: person.email, role: person.role });
    continue;
  }
  await db.insert(memberships).values({
    id: generateId(),
    organizationId,
    userId: row.id,
    role: person.role,
    /**
     * The MANAGER is scoped to ONE store, the OWNER to all of them. This is what gives the authz
     * model something real to enforce — a demo where everyone is an owner never exercises a single
     * store-scoped access check.
     */
    storeIds: person.storeCode === null ? [...storeIdByCode.values()] : [storeIdByCode.get(person.storeCode)!],
    ...(person.approvalLimit ? { approvalLimit: person.approvalLimit } : {}),
    acceptedAt: new Date(),
  });
}
log('org + stores + memberships', { organizationId, stores: storeIdByCode.size });

/* ------------------------------------------------------------------ catalog */

const categoryRepo = new CategoryRepository(db, organizationId);
const productRepo = new ProductRepository(db, organizationId);
const locationRepo = new StorageLocationRepository(db, organizationId);

const categoryIdByName = new Map<string, string>();
for (const category of categories) {
  const row = await categoryRepo.create({ id: generateId(), name: category.name });
  categoryIdByName.set(category.name, row.id);
}

/** Storage locations are per-store: each outlet has its own dry store and cold room. */
const locationIdByStoreAndName = new Map<string, string>();
const locationNames = [...new Set(products.map((p) => p.storageLocation))];
for (const [code, storeId] of storeIdByCode) {
  for (const name of locationNames) {
    const row = await locationRepo.create({ id: generateId(), storeId, name });
    locationIdByStoreAndName.set(`${code}:${name}`, row.id);
  }
}

const productBySku = new Map<string, { id: string; variantId: string; unitId: string; unitCode: string }>();
for (const p of products) {
  const row = await productRepo.create({
    id: generateId(),
    sku: p.sku,
    name: p.name,
    baseUnitId: unitIdFor(p.unitCode),
    type: 'INGREDIENT',
    categoryId: categoryIdByName.get(p.category)!,
    isPerishable: p.perishable,
  });
  const variants = await productRepo.findVariants(row.id);
  productBySku.set(p.sku, { id: row.id, variantId: variants[0]!.id, unitId: unitIdFor(p.unitCode), unitCode: p.unitCode });
}
log('catalog', { categories: categories.length, locations: locationIdByStoreAndName.size, products: products.length });

/* ------------------------------------------------------------------ suppliers + prices */

const supplierRepo = new SupplierRepository(db, organizationId);
const supplierProductRepo = new SupplierProductRepository(db, organizationId);
const supplierPriceRepo = new SupplierPriceRepository(db, organizationId);

const supplierIdByCode = new Map<string, string>();
for (const s of supplierSpecs) {
  const row = await supplierRepo.create({
    id: generateId(),
    name: s.name,
    paymentTerms: s.paymentTerms,
    leadTimeDaysContracted: s.leadTimeDays,
  });
  supplierIdByCode.set(s.code, row.id);
}

/**
 * Prices must predate the whole sales window. A `validFrom` after the earliest sale would leave that
 * period's recipe cost genuinely unresolvable — correct I7 behaviour, but not the intent here.
 */
const priceValidFrom = new Date(Date.now() - (meta.historyDays + 30) * 24 * 60 * 60 * 1000);

const supplierProductIdBySku = new Map<string, string>();
for (const sp of supplierProducts) {
  const product = productBySku.get(sp.sku);
  if (!product) continue;
  const link = await supplierProductRepo.create({
    id: generateId(),
    supplierId: supplierIdByCode.get(sp.supplierCode)!,
    productId: product.id,
    supplierSku: sp.supplierSku,
    packSize: sp.packSize,
    packUnitId: product.unitId,
    conversionToBase: sp.conversionToBase,
  });
  supplierProductIdBySku.set(sp.sku, link.id);
  if (sp.confirmed) await supplierProductRepo.confirm(link.id);
  await supplierPriceRepo.recordNewPrice({
    id: generateId(),
    supplierProductId: link.id,
    unitPrice: sp.basePackPrice,
    currency: CURRENCY,
    validFrom: priceValidFrom,
  });
}

/**
 * The deliberately unpriced product gets NO supplier mapping at all, so every menu item using it
 * resolves to a real *unknown* cost. Do not "fix" this: a demo where every number resolves proves
 * nothing about how missing data is handled, and "unknown, never zero" is the load-bearing claim.
 */
const unpriced = products.filter((p) => p.deliberatelyUnpriced).map((p) => p.sku);
log('suppliers', { suppliers: supplierSpecs.length, mappings: supplierProductIdBySku.size, deliberatelyUnpriced: unpriced });

/* ------------------------------------------------------------------ recipes + menu items */

const recipeRepo = new RecipeRepository(db, organizationId);
const menuItemRepo = new MenuItemRepository(db, organizationId);

const menuItemIdByName = new Map<string, string>();
for (const spec of menuItemSpecs) {
  const recipeGroupId = generateId();
  await recipeRepo.create({
    id: generateId(),
    recipeGroupId,
    name: spec.name,
    yieldQuantity: spec.yieldQuantity,
    yieldUnitId: unitIdFor(spec.yieldUnitCode),
    validFrom: priceValidFrom,
    components: spec.components.map((c) => ({
      componentType: 'PRODUCT' as const,
      productId: productBySku.get(c.sku)!.id,
      quantity: c.quantity,
      unitId: unitIdFor(productBySku.get(c.sku)!.unitCode),
    })),
  });
  const menuItem = await menuItemRepo.create({
    id: generateId(),
    name: spec.name,
    recipeGroupId,
    price: spec.price,
    priceValidFrom: priceValidFrom,
  });
  menuItemIdByName.set(spec.name, menuItem.id);
}
log('recipes + menu items', { count: menuItemSpecs.length });

/* ------------------------------------------------------------------ POS catalog */

const posItemRepo = new PosItemRepository(db, organizationId);

/** POS items are per-store, keyed `STORE:EXTERNAL_ID` — each outlet has its own till catalogue. */
const posItemIdByStoreAndExternal = new Map<string, string>();
for (const [code, storeId] of storeIdByCode) {
  for (const item of posItemsSpec.fromMenu) {
    const row = await posItemRepo.upsert({
      id: generateId(), storeId, source: 'square',
      externalId: item.externalId, name: item.posName, price: item.price, currency: CURRENCY,
    });
    posItemIdByStoreAndExternal.set(`${code}:${item.externalId}`, row.id);
    // The POS name deliberately differs from the menu item name ("MASALA DOSA" vs "Masala dosa") —
    // that mismatch is the real fuzzy-matching problem, and it survives being mapped.
    await posItemRepo.mapToMenuItem(row.id, menuItemIdByName.get(item.menuItemName)!);
  }
  for (const item of posItemsSpec.nonMenu) {
    const row = await posItemRepo.upsert({
      id: generateId(), storeId, source: 'square',
      externalId: item.externalId, name: item.name, price: item.price, currency: CURRENCY,
    });
    posItemIdByStoreAndExternal.set(`${code}:${item.externalId}`, row.id);
    /**
     * A parcel charge has no recipe and a gift card is not food. `ignore` records that as a REAL
     * state, distinct from "nobody has mapped it yet" — without it the dashboard's unmapped gate
     * treats them as a gap and suppresses every margin figure all-or-nothing.
     */
    await posItemRepo.ignore(row.id);
  }
}
log('pos catalogue', { perStore: posItemsSpec.fromMenu.length + posItemsSpec.nonMenu.length, total: posItemIdByStoreAndExternal.size });

/* ------------------------------------------------------------------ stock: real ledger */

const lotRepo = new LotRepository(db, organizationId);
const movements = new MovementService(db, organizationId);

/**
 * Replenishment is sized from ACTUAL consumption, computed by exploding every corpus sale through
 * its recipe — not hand-guessed. A hand-picked opening quantity either runs dry mid-window (which
 * silently truncates consumption and makes food-cost percentage read far too low) or sits absurdly
 * overstocked. Deriving it from the same sales the ledger will later consume is the only way the
 * two agree.
 *
 * Per-store, per-product base-unit demand across the whole window:
 */
const demandByStoreAndSku = new Map<string, number>();
const componentsByPosExternal = new Map<string, { sku: string; quantity: number }[]>();
for (const item of posItemsSpec.fromMenu) {
  const spec = menuItemSpecs.find((m) => m.name === item.menuItemName)!;
  // Recipe quantities are per BATCH, and the batch yields `yieldQuantity` units — dividing here is
  // what keeps a 12-portion batch from being charged as 12 full batches.
  // Decimal (I5): this per-portion quantity drives real recipe explosion and consumption
  // posting, so float division here propagates into every movement the seed writes.
  const yieldQty = new Decimal(spec.yieldQuantity);
  componentsByPosExternal.set(
    item.externalId,
    spec.components.map((c) => ({ sku: c.sku, quantity: new Decimal(c.quantity).dividedBy(yieldQty).toNumber() }))
  );
}

const addDemand = (storeCode: string, externalId: string, units: number) => {
  for (const component of componentsByPosExternal.get(externalId) ?? []) {
    const key = `${storeCode}:${component.sku}`;
    // `?? 0` here is accumulator initialisation, not a costing default: "no entry yet" genuinely
    // means zero demand accumulated so far. No cost is involved, so I7 does not apply.
    demandByStoreAndSku.set(key, (demandByStoreAndSku.get(key) ?? 0) + component.quantity * units);
  }
};
for (const day of aggregates) for (const item of day.items) addDemand(day.storeCode, item.externalId, item.units);
for (const store of meta.stores) {
  // Scoped so each store's receipts become garbage before the next file is read.
  for (const receipt of loadReceipts(store.code)) {
    if (receipt.status !== 'COMPLETED') continue;
    for (const line of receipt.lines) addDemand(receipt.storeCode, line.externalId, line.qty);
  }
}

/**
 * One real receipt per product per cycle, each sized to cover consumption until the next one with
 * headroom. Perishables get a shorter cycle: a single lot from 180 days ago would be long expired
 * and FEFO-invisible for most of the window, which is exactly what the expiry logic exists to model.
 */
const REPLENISH_DAYS_AMBIENT = 21;
const REPLENISH_DAYS_PERISHABLE = 5;
/** Headroom so a demand spike (Diwali) cannot exhaust a lot and silently truncate consumption. */
const REPLENISH_HEADROOM = 1.6;

const productBySkuSpec = new Map(products.map((p) => [p.sku, p]));
let lotsCreated = 0;
let receiptMovements = 0;

for (const store of meta.stores) {
  const storeId = storeIdByCode.get(store.code)!;
  for (const p of products) {
    /**
     * A deliberately unpriced product NEVER receives stock, because it cannot do so honestly.
     * `lots.unit_cost` is NOT NULL at the database layer, so receiving this product would force a
     * fabricated `0.0000` into the ledger — and a zero cost reads as FREE stock, inflating margin,
     * which is precisely the `?? 0` failure I7 exists to prevent. The earlier version did exactly
     * that, and the inventory screen duly showed "Vanilla extract — INR 0.00".
     *
     * Holding no stock is the truthful state: nobody has recorded what this costs, so nothing about
     * it can be valued. The recipe using it still resolves to a genuine "unknown".
     */
    if (p.deliberatelyUnpriced) continue;

    const totalDemand = demandByStoreAndSku.get(`${store.code}:${p.sku}`) ?? 0;
    if (totalDemand <= 0) continue;

    const cycleDays = p.perishable ? REPLENISH_DAYS_PERISHABLE : REPLENISH_DAYS_AMBIENT;
    // Respects --limit-days: replenishing across 180 days while only 7 days of sales exist would
    // leave every lot enormously overstocked and make stock-on-hand meaningless.
    const openDays = Math.min(store.opensDaysAgo, meta.historyDays, LIMIT_DAYS ?? Number.POSITIVE_INFINITY);
    const perDay = totalDemand / openDays;
    const perCycle = Math.ceil(perDay * cycleDays * REPLENISH_HEADROOM);
    if (perCycle <= 0) continue;

    let cycleIndex = 0;
    // Start one cycle BEFORE the store opens so day one already has stock — a store that opens with
    // an empty ledger would post its first sales against nothing and consume at unknown cost.
    for (let daysAgo = openDays + cycleDays; daysAgo >= 0; daysAgo -= cycleDays) {
      const receivedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
      const lot = await lotRepo.receive({
        id: generateId(),
        storeId,
        productId: productBySku.get(p.sku)!.id,
        variantId: productBySku.get(p.sku)!.variantId,
        lotNumber: `${store.code}-${p.sku}-L${++cycleIndex}`,
        receivedAt,
        initialQuantity: String(perCycle),
        unitCost: p.unitCost,
        currency: CURRENCY,
        ...(p.expiryInDays !== undefined
          ? { expiryDate: new Date(receivedAt.getTime() + p.expiryInDays * 86400000).toISOString().slice(0, 10) }
          : {}),
      });
      lotsCreated += 1;
      await movements.postMovement({
        storeId,
        productId: productBySku.get(p.sku)!.id,
        variantId: productBySku.get(p.sku)!.variantId,
        lotId: lot.id,
        movementType: 'RECEIPT',
        quantity: String(perCycle),
        unitCost: p.unitCost,
        currency: CURRENCY,
        occurredAt: receivedAt,
        sourceType: 'demo-seed',
        actorUserId: demoUser.id,
      });
      receiptMovements += 1;
    }
  }
  log('stock seeded', { store: store.code, lots: lotsCreated, receipts: receiptMovements });
}
void productBySkuSpec;

/* ------------------------------------------------------------------ sales: revenue + consumption */

const salesRepo = new SalesTransactionRepository(db, organizationId);
const pipeline = new SalesIngestionPipeline(db, organizationId);

const menuItemIdByPosExternal = new Map(
  posItemsSpec.fromMenu.map((i) => [i.externalId, menuItemIdByName.get(i.menuItemName)!])
);

let salesRecorded = 0;
let consumedLines = 0;
let quarantinedLines = 0;
/** Receipts an earlier run already recorded (and therefore already consumed) — see the resumability note below. */
let resumedSkips = 0;

/**
 * REVENUE and CONSUMPTION are driven by the SAME sale events. If revenue covered the full volume
 * while consumption only ran for part of it, food-cost percentage would come out implausibly low
 * for reasons that have nothing to do with the business.
 */

/** Older history is stored as daily aggregates; recent days are individual receipts. Both are real sales. */
for (const day of aggregates) {
  const storeId = storeIdByCode.get(day.storeCode)!;
  const occurredAt = new Date(`${day.date}T12:00:00.000Z`);
  for (const item of day.items) {
    // Decimal (I5): this is real money written into sales_transaction_lines, which every
    // revenue and margin metric then reads.
    const lineTotal = new Decimal(item.unitPrice).times(item.units).toFixed(4);
    const recordedAgg = await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId: `AGG-${day.storeCode}-${day.date}-${item.externalId}`,
      occurredAt,
      subtotal: lineTotal,
      discount: '0.0000',
      tax: '0.0000',
      total: lineTotal,
      currency: CURRENCY,
      lines: [
        {
          posItemId: posItemIdByStoreAndExternal.get(`${day.storeCode}:${item.externalId}`)!,
          quantity: item.units.toFixed(6),
          unitPrice: item.unitPrice,
          discount: '0.0000',
          lineTotal,
        },
      ],
    });
    // Same resumability guard as the receipt loop — consumption must not run twice (I3).
    if (recordedAgg.status === 'duplicate') {
      resumedSkips += 1;
      continue;
    }
    salesRecorded += 1;
    const result = await pipeline.ingestSaleLine({
      storeId,
      menuItemId: menuItemIdByPosExternal.get(item.externalId) ?? null,
      posItemExternalId: item.externalId,
      posItemName: item.posName,
      quantitySold: item.units.toFixed(6),
      revenue: lineTotal,
      currency: CURRENCY,
      occurredAt,
      sourceType: 'demo-seed',
      actorUserId: demoUser.id,
    });
    if (result.status === 'consumed') consumedLines += 1;
    else quarantinedLines += 1;
  }
  if (salesRecorded % 2000 === 0) log('aggregate sales', { salesRecorded, consumedLines });
}
log('aggregate sales complete', { salesRecorded, consumedLines, quarantinedLines });

for (const store of meta.stores) {
 // One store's receipts at a time — see loadReceipts. The array is released before the next store.
 for (const receipt of loadReceipts(store.code)) {
  const storeId = storeIdByCode.get(receipt.storeCode)!;
  const occurredAt = new Date(receipt.occurredAt);
  const recorded = await salesRepo.recordIfNew({
    storeId,
    source: 'square',
    externalId: receipt.externalId,
    occurredAt,
    subtotal: receipt.subtotal,
    discount: receipt.discount,
    // CGST and SGST are separate lines on a real Indian invoice but a single tax figure here — the
    // split is preserved in the source corpus and on the supplier PDFs, which is where it matters.
    tax: (Number(receipt.cgst) + Number(receipt.sgst)).toFixed(4),
    total: receipt.total,
    currency: CURRENCY,
    lines: receipt.lines.map((line) => ({
      posItemId: posItemIdByStoreAndExternal.get(`${receipt.storeCode}:${line.externalId}`)!,
      quantity: line.qty.toFixed(6),
      unitPrice: line.unitPrice,
      discount: '0.0000',
      lineTotal: line.lineTotal,
    })),
  });

  /**
   * RESUMABILITY, and it has to be here rather than as a separate progress file.
   *
   * `recordIfNew` is idempotent (`onConflictDoNothing`), but CONSUMPTION IS NOT: re-running would
   * post a second set of SALE_CONSUMPTION movements for a receipt already consumed. Because
   * `stock_movements` is append-only (I3), that damage cannot be undone by a later correction — the
   * ledger would simply be wrong, and stock-on-hand with it.
   *
   * A `duplicate` status means this exact receipt was already recorded by an earlier run, so its
   * consumption already happened too. Skipping it makes an interrupted run safely resumable with
   * `--skip-wipe`, which matters for a multi-hour unattended seed.
   */
  if (recorded.status === 'duplicate') {
    resumedSkips += 1;
    continue;
  }
  salesRecorded += 1;

  // A VOIDED receipt is recorded (it genuinely happened and appears in the POS export) but consumes
  // NOTHING — voiding is precisely the case where revenue and stock must not move together.
  if (receipt.status !== 'COMPLETED') continue;

  for (const line of receipt.lines) {
    const result = await pipeline.ingestSaleLine({
      storeId,
      menuItemId: menuItemIdByPosExternal.get(line.externalId) ?? null,
      posItemExternalId: line.externalId,
      posItemName: line.posName,
      quantitySold: line.qty.toFixed(6),
      revenue: line.lineTotal,
      currency: CURRENCY,
      occurredAt,
      sourceType: 'demo-seed',
      actorUserId: demoUser.id,
    });
    if (result.status === 'consumed') consumedLines += 1;
    else quarantinedLines += 1;
  }
  if (salesRecorded % 2000 === 0) log('receipt sales', { store: store.code, salesRecorded, consumedLines });
 }
 log('store receipts complete', { store: store.code, salesRecorded, consumedLines });
}

console.log(
  JSON.stringify(
    {
      stage: 'complete',
      organizationId,
      corpusSeed: meta.seed,
      profile: {
        limitDays: LIMIT_DAYS,
        maxReceiptsPerStoreDay: MAX_RECEIPTS_PER_STORE_DAY,
      },
      signInAs: owner.email,
      stores: storeIdByCode.size,
      products: products.length,
      menuItems: menuItemSpecs.length,
      suppliers: supplierSpecs.length,
      lots: lotsCreated,
      receiptMovements,
      salesRecorded,
      consumedLines,
      quarantinedLines,
      resumedSkips,
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
    },
    null,
    2
  )
);
await client.end();
process.exit(0);
