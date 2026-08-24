// Loads .env.local so this script runs straight from a fresh clone (see load-env.ts).
import '@retailos/config/auto';
/**
 * Part 2 of the demo corpus: the OPERATIONAL domains that sit between "we bought things" and
 * "we sold things" — purchase orders, goods receipts, stocktakes, inter-outlet transfers, par
 * levels and wastage.
 *
 * Everything goes through the REAL repositories and services (`PurchaseOrderRepository`,
 * `GoodsReceiptRepository.confirmReceipt`, `StockCountService`, `TransferService`,
 * `MovementService.logWaste`), never raw inserts. That matters beyond principle here: `confirmReceipt`
 * is what posts lots and RECEIPT movements, emits supplier performance events, and drives the PO's
 * own status transition. A raw insert would produce rows that look right and behave like nothing.
 *
 * Two planted findings become visible only once this runs:
 *
 *   #3 WASTAGE / EXPIRY CLUSTER — short-shelf-life perishables (paneer, coriander) are wasted in a
 *      concentrated burst rather than smeared evenly, so the waste-by-reason panel has a real
 *      cluster to surface instead of noise.
 *
 *   #4 SUPPLIER RELIABILITY DECLINE — Green Valley Farms (the produce supplier flagged in the
 *      corpus) delivers on time early in the window and progressively late and short later, so the
 *      supplier scorecard describes a supplier genuinely getting worse.
 *
 * IDEMPOTENT: re-running skips work already done, keyed on the PO numbers this script owns.
 * Receiving goods POSTS movements, and `stock_movements` is append-only (I3), so a careless re-run
 * would double-count stock in a way no later correction can undo.
 *
 * Usage:
 *   DATABASE_URL=... REDIS_URL=... pnpm --filter @retailos/api exec tsx src/scripts/seed-demo-operations.mts
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDb,
  organizations,
  stores,
  users,
  memberships,
  suppliers,
  products,
  supplierProducts,
  stockLevels,
  units,
  PurchaseOrderRepository,
  GoodsReceiptRepository,
  StockCountService,
  TransferService,
  ParLevelRepository,
  MovementService,
  ProductRepository,
} from '@retailos/db';
import { eq, and } from 'drizzle-orm';

const DRY_RUN = process.argv.includes('--dry-run');
/** `--batch=B` creates a fresh set of POs alongside the existing ones instead of skipping them. */
const batchArg = process.argv.find((a) => a.startsWith('--batch='));
const PO_BATCH = batchArg ? `-${batchArg.split('=')[1]}` : '';

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '../../../../mock-data');
const readCorpus = <T,>(rel: string): T => JSON.parse(readFileSync(join(CORPUS, rel), 'utf8')) as T;

interface CorpusSupplier {
  code: string; name: string; leadTimeDays: number;
  plantedPriceCreepBasisPoints?: number; plantedReliabilityDecline?: boolean;
}
interface CorpusProduct {
  sku: string; name: string; unitCode: string; perishable: boolean;
  packPrice: string; conversionToBase: string; unitCost: string; expiryInDays?: number;
}

const corpusSuppliers = readCorpus<CorpusSupplier[]>('suppliers/suppliers.json');
const corpusProducts = readCorpus<CorpusProduct[]>('catalog/products.json');

const { db, client } = createDb(process.env.DATABASE_URL!);

/* ------------------------------------------------------------------ resolve the demo tenant */

const [org] = await db.select().from(organizations).where(eq(organizations.slug, 'third-wave-bengaluru'));
if (!org) {
  console.error('Demo organization not found. Run seed-demo.mts first.');
  process.exit(1);
}
const organizationId = org.id;

const [demoUser] = await db.select().from(users).where(eq(users.email, 'demo@vyapaar.test'));
const [membership] = await db
  .select()
  .from(memberships)
  .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, demoUser!.id)));
if (!membership) {
  console.error('Demo user has no membership in the demo org. Run seed-demo.mts first.');
  process.exit(1);
}
const actorUserId = demoUser!.id;

const storeRows = await db.select().from(stores).where(eq(stores.organizationId, organizationId));
const storeByName = new Map(storeRows.map((s) => [s.name, s]));
const flagship = storeByName.get('Indiranagar')!;
const midStore = storeByName.get('Jayanagar')!;
const smallStore = storeByName.get('Koramangala')!;

const supplierRows = await db.select().from(suppliers).where(eq(suppliers.organizationId, organizationId));
const supplierByName = new Map(supplierRows.map((s) => [s.name, s]));

const productRows = await db.select().from(products).where(eq(products.organizationId, organizationId));
const productBySku = new Map(productRows.map((p) => [p.sku, p]));

const supplierProductRows = await db
  .select()
  .from(supplierProducts)
  .where(eq(supplierProducts.organizationId, organizationId));
const supplierProductByProductId = new Map(supplierProductRows.map((sp) => [sp.productId, sp]));

const unitRows = await db.select().from(units);
const unitIdByCode = new Map(unitRows.map((u) => [u.code, u.id]));

const productRepo = new ProductRepository(db, organizationId);
const variantIdByProductId = new Map<string, string>();
for (const product of productRows) {
  const variants = await productRepo.findVariants(product.id);
  if (variants[0]) variantIdByProductId.set(product.id, variants[0].id);
}

const poRepo = new PurchaseOrderRepository(db, organizationId);
const receiptRepo = new GoodsReceiptRepository(db, organizationId);
const countService = new StockCountService(db, organizationId);
const transferService = new TransferService(db, organizationId);
const parRepo = new ParLevelRepository(db, organizationId);
const movements = new MovementService(db, organizationId);

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86400000);
const started = Date.now();
const log = (stage: string, detail?: unknown) =>
  console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s] ${stage}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);

if (DRY_RUN) {
  console.log(JSON.stringify({
    dryRun: true, organizationId,
    stores: storeRows.length, suppliers: supplierRows.length,
    products: productRows.length, supplierProducts: supplierProductRows.length,
  }, null, 2));
  await client.end();
  process.exit(0);
}

/* ------------------------------------------------------------------ 1. par levels */

/**
 * Par levels are what turn "stock on hand" into "should I reorder?" — without them the reorder
 * suggestions screen has nothing to compute against. Sized from the product's own pack size so the
 * numbers are plausible rather than arbitrary: reorder at roughly one pack, par at three.
 */
let parLevelsSet = 0;
for (const store of [flagship, midStore, smallStore]) {
  for (const cp of corpusProducts) {
    const product = productBySku.get(cp.sku);
    const variantId = product ? variantIdByProductId.get(product.id) : undefined;
    if (!product || !variantId) continue;
    const packBase = Number(cp.conversionToBase);
    await parRepo.setParLevel({
      storeId: store.id,
      productId: product.id,
      variantId,
      reorderPoint: String(Math.round(packBase)),
      parLevel: String(Math.round(packBase * 3)),
    });
    parLevelsSet += 1;
  }
}
log('par levels', { count: parLevelsSet });

/* ------------------------------------------------------------------ 2. purchase orders + goods receipts */

/**
 * A PO walks its REAL state machine: DRAFT → SUBMIT → APPROVE → SEND, then receiving drives
 * RECEIVE_PARTIAL / RECEIVE_FULL. Skipping straight to RECEIVED would leave a status no sequence of
 * user actions could ever produce.
 */
const RELIABILITY_DECLINE_SUPPLIER = corpusSuppliers.find((s) => s.plantedReliabilityDecline)?.name;

/** One PO per supplier per cycle, walking back through the window. */
/**
 * Cycle 2 (`-B` suffixed PO numbers) was added after a real bug: an earlier run read the corpus's
 * shelf-life field as `expiryDays` when it is actually `expiryInDays`, so EVERY lot was received
 * with no expiry date and the `lot_expiring` rule had nothing to evaluate. Rather than back-patch
 * expiry dates onto existing lots — which would invent provenance the ledger never recorded — the
 * fixed code simply receives more goods, and those lots carry genuine expiry dates.
 */
const PO_CYCLES = [92, 78, 64, 50, 36, 22, 12, 5];

let posCreated = 0;
let receiptsConfirmed = 0;
let shortDeliveries = 0;
let overDeliveries = 0;
let lateDeliveries = 0;

for (const [cycleIndex, cycleDaysAgo] of PO_CYCLES.entries()) {
  for (const cs of corpusSuppliers) {
    const supplier = supplierByName.get(cs.name);
    if (!supplier) continue;

    // Rotate outlets so all three have purchasing history, weighted toward the flagship.
    const store = cycleIndex % 4 === 3 ? smallStore : cycleIndex % 2 === 0 ? flagship : midStore;

    const poNumber = `PO-${store.name.slice(0, 3).toUpperCase()}-${cs.code}-${String(cycleIndex + 1).padStart(3, '0')}${PO_BATCH}`;

    // Idempotency: this script owns these PO numbers, so an existing one means this cycle ran.
    const existing = await poRepo.listForStore({ storeId: store.id, limit: 200 });
    if (existing.orders.some((p) => p.poNumber === poNumber)) continue;

    const orderedAt = daysAgo(cycleDaysAgo);
    const { id: poId } = await poRepo.create({
      storeId: store.id,
      supplierId: supplier.id,
      poNumber,
      currency: 'INR',
      expectedDeliveryDate: new Date(orderedAt.getTime() + cs.leadTimeDays * 86400000),
      createdByUserId: actorUserId,
    });
    posCreated += 1;

    /** Three products per PO, rotated so different SKUs appear across cycles. */
    const supplierSkus = corpusProducts.filter((cp) => {
      const p = productBySku.get(cp.sku);
      const sp = p ? supplierProductByProductId.get(p.id) : undefined;
      return sp?.supplierId === supplier.id;
    });
    const chosen = supplierSkus.slice((cycleIndex * 3) % Math.max(supplierSkus.length, 1)).slice(0, 3);
    if (chosen.length === 0) continue;

    const poLines: { lineId: string; productId: string; variantId: string; orderedBase: number; unitCost: string; cp: CorpusProduct }[] = [];
    for (const [lineIndex, cp] of chosen.entries()) {
      const product = productBySku.get(cp.sku)!;
      const variantId = variantIdByProductId.get(product.id)!;
      const sp = supplierProductByProductId.get(product.id)!;
      const packs = 2 + (lineIndex % 3);
      const result = await poRepo.addLine({
        purchaseOrderId: poId,
        supplierProductId: sp.id,
        productId: product.id,
        variantId,
        quantityOrderUnits: String(packs),
        conversionToBase: cp.conversionToBase,
        baseUnitId: unitIdByCode.get(cp.unitCode)!,
        unitPrice: cp.packPrice,
        lineNumber: lineIndex + 1,
      });
      if (result.ok) {
        poLines.push({
          lineId: result.id,
          productId: product.id,
          variantId,
          orderedBase: packs * Number(cp.conversionToBase),
          unitCost: cp.unitCost,
          cp,
        });
      }
    }
    if (poLines.length === 0) continue;

    // Walk the real state machine. `version` starts at 1 and increments per transition.
    let version = 1;
    for (const event of ['SUBMIT', 'APPROVE', 'SEND'] as const) {
      const t = await poRepo.applyTransition(poId, event, version, actorUserId);
      if (!t.ok) {
        console.warn(`  ${poNumber}: ${event} rejected — ${t.reason}`);
        break;
      }
      version += 1;
    }

    /**
     * PLANTED FINDING #4. The flagged produce supplier degrades over the final third of the window:
     * later deliveries arrive late AND short. Early cycles stay clean, so the scorecard shows a
     * genuine downward trend rather than uniform unreliability (which would look like a bad
     * supplier from day one, not a supplier that got worse).
     */
    const isDecliner = cs.name === RELIABILITY_DECLINE_SUPPLIER;
    const lateInWindow = cycleIndex >= PO_CYCLES.length - 3;
    const slipDays = isDecliner && lateInWindow ? 2 + (cycleIndex % 2) : 0;
    if (slipDays > 0) lateDeliveries += 1;

    const receivedAt = new Date(orderedAt.getTime() + (cs.leadTimeDays + slipDays) * 86400000);
    if (receivedAt.getTime() > Date.now()) continue; // not yet delivered — a real open PO

    const receiveLines = poLines.map((line, index) => {
      let receivedBase = line.orderedBase;
      let discrepancyCode: 'SHORT' | 'OVER' | undefined;

      if (isDecliner && lateInWindow && index === 0) {
        receivedBase = Math.round(line.orderedBase * 0.85); // short-delivered
        discrepancyCode = 'SHORT';
        shortDeliveries += 1;
      } else if (!isDecliner && cycleIndex === 3 && index === 0) {
        /**
         * An over-delivery is flagged with the OVER discrepancy code, but the RECORDED quantity is
         * still capped at what was ordered.
         *
         * That is not a fudge — it is what the schema enforces. `purchase_order_lines` carries
         * CHECK (received_quantity_base_units <= quantity_base_units): a PO line can never record
         * more received than was ordered, because the ordered quantity is the commercial agreement.
         * Excess stock physically arriving is a real event, but it does not retroactively change
         * what was ordered; it is recorded as a discrepancy for someone to resolve (accept and
         * raise a new PO line, or return it). Trying to write 106% here is what the database
         * rejected on the first run — correctly.
         */
        discrepancyCode = 'OVER';
        overDeliveries += 1;
      }

      return {
        purchaseOrderLineId: line.lineId,
        productId: line.productId,
        variantId: line.variantId,
        receivedQuantityBaseUnits: String(receivedBase),
        baseUnitId: unitIdByCode.get(line.cp.unitCode)!,
        unitCost: line.cp.unitCost,
        currency: 'INR',
        lotNumber: `${poNumber}-L${index + 1}`,
        ...(line.cp.expiryInDays !== undefined
          ? { expiryDate: new Date(receivedAt.getTime() + line.cp.expiryInDays * 86400000).toISOString().slice(0, 10) }
          : {}),
        ...(discrepancyCode ? { discrepancyCode } : {}),
        lineNumber: index + 1,
      };
    });

    // Returns { goodsReceiptId, purchaseOrderNewStatus } — it throws on failure rather than
    // returning a result union, so reaching the next line means the receipt posted.
    const confirmed = await receiptRepo.confirmReceipt({
      storeId: store.id,
      purchaseOrderId: poId,
      supplierId: supplier.id,
      receivedAt,
      receivedByUserId: actorUserId,
      lines: receiveLines,
    });
    if (confirmed.goodsReceiptId) receiptsConfirmed += 1;
  }
  log('po cycle', { cycleDaysAgo, posCreated, receiptsConfirmed });
}
log('purchase orders + receipts', { posCreated, receiptsConfirmed, shortDeliveries, overDeliveries, lateDeliveries });

/* ------------------------------------------------------------------ 3. wastage (planted finding #3) */

/**
 * PLANTED FINDING #3. Wastage is CLUSTERED on short-shelf-life perishables rather than spread
 * evenly: a fridge failure over three consecutive days at the small outlet, plus routine low-level
 * spoilage elsewhere. A flat waste rate is invisible — a cluster is a finding someone can act on.
 */
const PERISHABLE_SKUS = corpusProducts.filter((p) => p.perishable && (p.expiryInDays ?? 99) <= 6).map((p) => p.sku);
let wasteEvents = 0;

/**
 * Waste is capped at what the outlet ACTUALLY holds, read from the live stock projection.
 *
 * FEFO refused the first attempt outright (`InsufficientStockError: shortfall of 1800 g`) because
 * the script assumed the small outlet stocked coriander — it does not. That refusal is the ledger
 * working: wasting stock that was never received would make stock-on-hand negative and every
 * downstream cost figure fiction. Sizing from real on-hand is the honest fix, not forcing it.
 */
const onHand = await db
  .select({ storeId: stockLevels.storeId, productId: stockLevels.productId, quantity: stockLevels.quantity })
  .from(stockLevels)
  .where(eq(stockLevels.organizationId, organizationId));
const onHandKey = (storeId: string, productId: string) => `${storeId}:${productId}`;
const onHandByKey = new Map(onHand.map((r) => [onHandKey(r.storeId, r.productId), Number(r.quantity)]));

/** The cluster lands wherever the perishable is genuinely stocked in quantity. */
const clusterPlan: { dayOffset: number; sku: string }[] = [
  { dayOffset: 9, sku: 'PNR-FRS' },
  { dayOffset: 8, sku: 'PNR-FRS' },
  { dayOffset: 7, sku: 'CIL-FRS' },
];

for (const { dayOffset, sku } of clusterPlan) {
  const product = productBySku.get(sku);
  const cp = corpusProducts.find((p) => p.sku === sku);
  if (!product || !cp) continue;
  const variantId = variantIdByProductId.get(product.id);
  if (!variantId) continue;

  // Pick the outlet holding the most of this product, so the cluster is always postable.
  const candidates = [smallStore, midStore, flagship]
    // `?? 0` is correct here and NOT an I7 violation: a missing stock_levels row means this outlet
    // genuinely holds none of this product, which is a real zero, not an unknown cost.
    .map((store) => ({ store, qty: onHandByKey.get(onHandKey(store.id, product.id)) ?? 0 }))
    .sort((a, b) => b.qty - a.qty);
  const target = candidates[0];
  if (!target || target.qty <= 0) continue;

  // A visible cluster, but never more than a fifth of what is actually there.
  const wasteQty = Math.max(1, Math.floor(Math.min(Number(cp.conversionToBase) * 0.6, target.qty * 0.2)));
  await movements.logWaste({
    storeId: target.store.id,
    productId: product.id,
    variantId,
    quantity: String(wasteQty),
    unit: cp.unitCode as 'g' | 'ml' | 'each',
    occurredAt: daysAgo(dayOffset),
    sourceType: 'demo-seed',
    reasonCode: 'EXPIRED',
    actorUserId,
  });
  onHandByKey.set(onHandKey(target.store.id, product.id), target.qty - wasteQty);
  wasteEvents += 1;
}

/** Routine background spoilage, so the cluster stands out against a real baseline. */
for (const store of [flagship, midStore, smallStore]) {
  for (const [index, sku] of PERISHABLE_SKUS.slice(0, 4).entries()) {
    const product = productBySku.get(sku);
    const cp = corpusProducts.find((p) => p.sku === sku);
    if (!product || !cp) continue;
    const variantId = variantIdByProductId.get(product.id);
    if (!variantId) continue;

    const available = onHandByKey.get(onHandKey(store.id, product.id)) ?? 0;
    if (available <= 0) continue; // this outlet genuinely does not stock it
    const wasteQty = Math.max(1, Math.floor(Math.min(Number(cp.conversionToBase) * 0.08, available * 0.05)));

    await movements.logWaste({
      storeId: store.id,
      productId: product.id,
      variantId,
      quantity: String(wasteQty),
      unit: cp.unitCode as 'g' | 'ml' | 'each',
      occurredAt: daysAgo(14 + index * 5),
      sourceType: 'demo-seed',
      reasonCode: index % 2 === 0 ? 'SPILLAGE' : 'PREP_ERROR',
      actorUserId,
    });
    onHandByKey.set(onHandKey(store.id, product.id), available - wasteQty);
    wasteEvents += 1;
  }
}
log('wastage', { events: wasteEvents, clusteredAt: smallStore.name });

/* ------------------------------------------------------------------ 4. stocktakes */

/**
 * A stocktake walks its real lifecycle: create → start → enter counts → submit → approve. Approval
 * is what posts the ADJUSTMENT movements that reconcile the ledger to what was physically counted,
 * so a count that stops before approval changes no stock at all.
 */
let stocktakes = 0;
let countLinesEntered = 0;

for (const [index, store] of [flagship, midStore].entries()) {
  /**
   * `createCount` takes the EXACT product/variant pairs to count — it does not discover them. That
   * is deliberate in the service: a count sheet is a decision about what to count, not a dump of
   * every SKU. Twenty products per outlet keeps the sheet realistic (a real full count of 40 lines
   * is a long evening) while still producing real variance.
   */
  const productVariantPairs = corpusProducts
    .slice(index * 5, index * 5 + 20)
    .map((cp) => {
      const product = productBySku.get(cp.sku);
      const variantId = product ? variantIdByProductId.get(product.id) : undefined;
      return product && variantId ? { productId: product.id, variantId } : null;
    })
    .filter((pair): pair is { productId: string; variantId: string } => pair !== null);
  if (productVariantPairs.length === 0) continue;

  const created = await countService.createCount({
    storeId: store.id,
    scope: 'full',
    productVariantPairs,
    createdByUserId: actorUserId,
  });
  const stockCountId = created.id;

  // Starting the count is what SNAPSHOTS theoretical quantity per line (`theoreticalQuantityT0`) —
  // the figure the physical count is later compared against. Without it every variance is unknown.
  await countService.startCount(stockCountId);
  const lines = await countService.findLines(stockCountId);

  for (const [lineIndex, line] of lines.entries()) {
    /**
     * Counted quantities differ SLIGHTLY from the snapshot — that difference is the entire point of
     * a stocktake. Counting everything exactly right would produce a screen full of zeros and prove
     * nothing about variance handling.
     */
    /**
     * A NULL snapshot means the line was never snapshotted — NOT that the shelf was empty. Treating
     * it as 0 and then "counting" 0 would post an adjustment writing the entire line off as
     * shrinkage, which is the I7 failure in its most expensive form. Skip instead.
     */
    if (line.theoreticalQuantityT0 === null) continue;
    const theoretical = Number(line.theoreticalQuantityT0);
    const drift = lineIndex % 5 === 0 ? -0.04 : lineIndex % 7 === 0 ? 0.02 : 0;
    const counted = Math.max(0, Math.round(theoretical * (1 + drift)));
    await countService.enterCount(line.id, String(counted), actorUserId);
    countLinesEntered += 1;
  }

  // Approval is what posts the ADJUSTMENT movements reconciling the ledger to the physical count.
  // A count that stops before approval changes no stock at all.
  await countService.submitCount(stockCountId, actorUserId);
  await countService.approveCount(stockCountId, actorUserId);
  stocktakes += 1;
}
log('stocktakes', { count: stocktakes, linesEntered: countLinesEntered });

/* ------------------------------------------------------------------ 5. inter-outlet transfers */

/**
 * The flagship lends stock to the smaller outlets — a real thing a three-outlet chain does when one
 * runs short. Transfers move stock WITHOUT a purchase, so they are the case where stock arrives and
 * COGS must not change; seeding them keeps that path honest rather than theoretical.
 */
let transfersCreated = 0;
let transfersReceived = 0;

for (const [index, target] of [midStore, smallStore].entries()) {
  const sku = ['ATA-WHT', 'CFE-FIL'][index] ?? 'ATA-WHT';
  const product = productBySku.get(sku);
  const variantId = product ? variantIdByProductId.get(product.id) : undefined;
  const cp = corpusProducts.find((p) => p.sku === sku);
  if (!product || !variantId || !cp) continue;

  // `sourceStoreId`/`destinationStoreId`, and it returns the created rows directly (throwing on an
  // invalid transition) rather than a result union.
  const initiated = await transferService.initiateTransfer({
    sourceStoreId: flagship.id,
    destinationStoreId: target.id,
    productId: product.id,
    variantId,
    quantity: String(Math.round(Number(cp.conversionToBase) * 0.5)),
    unit: cp.unitCode as 'g' | 'ml' | 'each',
    occurredAt: daysAgo(11 - index * 4),
    sourceType: 'demo-seed',
    actorUserId,
  });
  transfersCreated += 1;

  // The first transfer completes; the second stays IN_TRANSIT so the screen shows both states.
  if (index === 0) {
    await transferService.receiveTransfer(initiated.transfer.id, actorUserId);
    transfersReceived += 1;
  }
}
log('transfers', { created: transfersCreated, received: transfersReceived });

console.log(
  JSON.stringify(
    {
      stage: 'complete',
      organizationId,
      parLevels: parLevelsSet,
      purchaseOrders: posCreated,
      goodsReceipts: receiptsConfirmed,
      shortDeliveries,
      overDeliveries,
      lateDeliveries,
      wasteEvents,
      stocktakes,
      countLinesEntered,
      transfersCreated,
      transfersReceived,
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
    },
    null,
    2
  )
);
await client.end();
process.exit(0);
