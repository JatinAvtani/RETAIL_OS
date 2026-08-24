/**
 * Deterministic corpus generator.
 *
 *   pnpm --filter @retailos/api exec tsx ../../mock-data/generate/generate.mts
 *
 * Writes browsable JSON (and invoice PDFs) into mock-data/. Data output is gitignored; THIS
 * directory is committed, so a fresh clone regenerates a byte-identical corpus from source.
 *
 * Determinism rules, all load-bearing:
 *  - every random draw comes from `Rng` seeded with CORPUS_SEED — never `Math.random()`
 *  - every date is an offset from a SINGLE `generatedAt` captured once at startup, never
 *    `Date.now()` called repeatedly (which would drift mid-run and make two runs differ)
 *  - object key order is fixed by construction, so `JSON.stringify` output is stable
 *
 * The one intentional exception: `generatedAt` itself differs between runs. It is written to
 * meta.json only, and the determinism check diffs everything EXCEPT meta.json — see `--verify`.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rng, CORPUS_SEED } from './rng.mts';
import { PRODUCTS, MENU_ITEMS, NON_MENU_POS_ITEMS, CATEGORIES, type CatalogProduct } from './catalog.mts';
import { SUPPLIERS, BUYER } from './suppliers.mts';
import { STORES, STAFF, ORGANIZATION, HISTORY_DAYS, RECEIPT_LEVEL_DAYS, DIWALI } from './stores.mts';
import { mulPackPrice, sumMoney, mulBasisPoints, applyPercent, toDisplay2dp } from './money.mts';
import { buildInvoicePdf } from './pdf.mts';
import { buildFindingsDoc } from './findings.mts';
import { buildReceiptsForDay, type Receipt } from './sales.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const DAY_MS = 24 * 60 * 60 * 1000;
/** Captured ONCE. Every other date derives from this, so a run cannot straddle midnight and produce two different corpora. */
const generatedAt = new Date();
/** Midnight-anchored so day offsets are stable regardless of what time of day the generator runs. */
const today = new Date(Date.UTC(generatedAt.getUTCFullYear(), generatedAt.getUTCMonth(), generatedAt.getUTCDate()));
const dayOffset = (daysAgo: number): Date => new Date(today.getTime() - daysAgo * DAY_MS);
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

const write = (relPath: string, data: unknown): void => {
  const full = join(ROOT, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

// Clear previously generated data so a re-run can never leave orphaned files behind that would
// make a diff-based determinism check pass for the wrong reason.
for (const dir of ['catalog', 'suppliers', 'documents', 'operations', 'sales', 'findings']) {
  rmSync(join(ROOT, dir), { recursive: true, force: true });
}

const rng = new Rng(CORPUS_SEED);
const productBySku = new Map(PRODUCTS.map((p) => [p.sku, p]));

/* ------------------------------------------------------------------ catalog */

write('catalog/categories.json', CATEGORIES.map((name) => ({ name })));
write('catalog/products.json', PRODUCTS);
write('catalog/menu-items.json', MENU_ITEMS);
write('catalog/pos-items.json', {
  fromMenu: MENU_ITEMS.map((m, i) => ({
    externalId: `POS-${1001 + i}`,
    posName: m.posName,
    menuItemName: m.name,
    price: m.price,
    flagshipPerDay: m.flagshipPerDay,
  })),
  nonMenu: NON_MENU_POS_ITEMS,
});

/* ------------------------------------------------------------------ suppliers */

write('suppliers/suppliers.json', SUPPLIERS.map((s) => ({
  code: s.code,
  name: s.name,
  gstin: s.gstin,
  address: s.address,
  paymentTerms: s.paymentTerms,
  leadTimeDays: s.leadTimeDays,
  plantedPriceCreepBasisPoints: s.priceCreepBasisPoints ?? null,
  plantedReliabilityDecline: s.reliabilityDecline ?? false,
})));

write('suppliers/supplier-products.json', SUPPLIERS.flatMap((s) =>
  s.skus.map((sku) => {
    const product = productBySku.get(sku);
    if (!product) throw new Error(`Supplier ${s.code} lists unknown SKU ${sku}`);
    return {
      supplierCode: s.code,
      sku,
      supplierSku: `${s.code}-${sku}`,
      packLabel: product.packLabel,
      packSize: product.packLabel.split(' ')[0] ?? '1',
      conversionToBase: product.conversionToBase,
      basePackPrice: product.packPrice,
      /** Deliberately unpriced products get NO confirmed mapping — see catalog.mts's I7 note. */
      confirmed: !product.deliberatelyUnpriced,
    };
  })
));

/* ------------------------------------------------------------------ invoices (GST tax invoices) */

interface InvoiceLine { sku: string; supplierSku: string; description: string; hsn: string; qty: string; unitPrice: string; lineTotal: string; gstBasisPoints: number }
interface Invoice {
  number: string; supplierCode: string; supplierName: string; gstin: string; supplierAddress: string;
  date: string; storeCode: string; lines: InvoiceLine[];
  subtotal: string; cgst: string; sgst: string; total: string;
  plantedNote?: string;
}

/**
 * Price creep is applied in DISCRETE STEPS, not continuously: `detectPriceChange` only fires when a
 * change crosses its threshold, so a smooth ramp of +0.1% per invoice would produce a real upward
 * trend that never triggers a single event. Four steps across the window each clear the threshold.
 *
 * The step boundaries are computed against the REAL invoice range (first invoice at
 * HISTORY_DAYS-4, last at FINAL_INVOICE_DAYS_AGO), not against HISTORY_DAYS. An earlier version
 * divided by HISTORY_DAYS, which put the final step at `daysAgo <= 0` — beyond the last invoice —
 * so the top quarter of the creep was unreachable and the observed drift came out at +9.7% instead
 * of the intended +13%. Measured against the generated corpus, not assumed.
 */
const FIRST_INVOICE_DAYS_AGO = HISTORY_DAYS - 4;
const INVOICE_INTERVAL_DAYS = 12;
/**
 * The genuine last invoice day, derived from the same loop that emits them rather than assumed.
 * A hardcoded guess here is what produced an earlier bug: the loop steps by 12 from 176 and stops
 * at 8, never reaching a hardcoded floor of 3, so the top creep step was unreachable and the
 * observed drift capped at +9.75% instead of the intended +13%.
 */
const FINAL_INVOICE_DAYS_AGO =
  FIRST_INVOICE_DAYS_AGO - Math.floor((FIRST_INVOICE_DAYS_AGO - 3) / INVOICE_INTERVAL_DAYS) * INVOICE_INTERVAL_DAYS;
const INVOICE_SPAN_DAYS = FIRST_INVOICE_DAYS_AGO - FINAL_INVOICE_DAYS_AGO;

const creepStepFor = (supplierCode: string, daysAgo: number): number => {
  const supplier = SUPPLIERS.find((s) => s.code === supplierCode);
  if (!supplier?.priceCreepBasisPoints) return 0;
  const elapsed = FIRST_INVOICE_DAYS_AGO - daysAgo;
  // Four steps across the real span; the +1e-9 guards float division landing a hair under an exact
  // boundary (168/168*4 = 3.9999...), which would silently cost the final step.
  const step = Math.min(4, Math.floor((elapsed / INVOICE_SPAN_DAYS) * 4 + 1e-9));
  return Math.round((supplier.priceCreepBasisPoints * step) / 4);
};

const invoices: Invoice[] = [];
let invoiceSeq = 1;

// Deliveries land every ~12 days per supplier across the window. The flagship receives most
// stock; the other outlets receive proportionally less, matching their sales scale.
for (const supplier of SUPPLIERS) {
  for (let daysAgo = HISTORY_DAYS - 4; daysAgo >= 3; daysAgo -= 12) {
    const store = rng.chance(0.62) ? STORES[0]! : rng.pick(STORES.filter((s) => s.opensDaysAgo >= daysAgo));
    const creep = creepStepFor(supplier.code, daysAgo);

    // 2-4 real lines per invoice, drawn from what this supplier actually sells.
    const skus = rng.shuffle(supplier.skus.filter((sku) => !productBySku.get(sku)?.deliberatelyUnpriced)).slice(0, rng.int(2, 4));
    const lines: InvoiceLine[] = skus.map((sku) => {
      const product = productBySku.get(sku)!;
      const unitPrice = creep > 0 ? applyPercent(product.packPrice, creep) : product.packPrice;
      const qty = String(rng.int(2, 9));
      return {
        sku,
        supplierSku: `${supplier.code}-${sku}`,
        description: `${product.name}, ${product.packLabel}`,
        hsn: product.hsn,
        qty,
        unitPrice,
        lineTotal: mulPackPrice(qty, unitPrice),
        gstBasisPoints: product.gstBasisPoints,
      };
    });

    const subtotal = sumMoney(lines.map((l) => l.lineTotal));
    // Intra-state supply (supplier and buyer are both Karnataka/29) splits GST into CGST + SGST at
    // half the rate each. Computed per line, because rates genuinely differ by commodity.
    const cgst = sumMoney(lines.map((l) => mulBasisPoints(l.lineTotal, l.gstBasisPoints / 2)));
    const sgst = cgst;

    invoices.push({
      number: `${supplier.code}/24-25/${String(invoiceSeq++).padStart(4, '0')}`,
      supplierCode: supplier.code,
      supplierName: supplier.name,
      gstin: supplier.gstin,
      supplierAddress: supplier.address,
      date: isoDate(dayOffset(daysAgo)),
      storeCode: store.code,
      lines,
      subtotal,
      cgst,
      sgst,
      total: sumMoney([subtotal, cgst, sgst]),
      ...(creep > 0 ? { plantedNote: `price creep step: +${(creep / 100).toFixed(2)}% vs baseline` } : {}),
    });
  }
}

invoices.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.number < b.number ? -1 : 1));
write('documents/invoices.json', invoices);

for (const invoice of invoices) {
  // Each supplier prints on its own stationery — see InvoiceLayout in suppliers.mts.
  const layout = SUPPLIERS.find((s) => s.code === invoice.supplierCode)!.layout;
  const pdf = buildInvoicePdf(invoice, BUYER, layout);
  const path = join(ROOT, 'documents/pdf', `${invoice.number.replace(/\//g, '-')}.pdf`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, pdf);
}

/* ------------------------------------------------------------------ sales */

/**
 * Individual POS receipts — what a real Square/Petpooja export actually contains: timestamped
 * orders with an order id, a payment mode, GST, and multi-line baskets. Daily aggregates were the
 * earlier shape and were genuinely too convenient: no timestamps means no daypart analysis, no
 * payment mode means the settlement mix is invisible, and no order identity means nothing can be
 * voided or reconciled.
 *
 * Written one file per store to keep any single JSON file openable in an editor.
 */
const posIdByMenuName = new Map(MENU_ITEMS.map((m, i) => [m.name, `POS-${1001 + i}`]));
const menuByName = new Map(MENU_ITEMS.map((m) => [m.name, m]));

/** Per-store, per-day unit totals — the intermediate the receipt builder expands. */
interface DayUnits { date: Date; daysAgo: number; items: { externalId: string; posName: string; menuName: string; unitPrice: string; units: number }[] }

const allReceipts: Receipt[] = [];
const dayUnitsByStore = new Map<string, DayUnits[]>();

for (const store of STORES) {
  const days: DayUnits[] = [];
  let receiptSeq = 0;
  const seq = () => ++receiptSeq;

  for (let daysAgo = Math.min(HISTORY_DAYS, store.opensDaysAgo); daysAgo >= 0; daysAgo--) {
    const date = dayOffset(daysAgo);
    const weekday = date.getUTCDay();
    // Weekends genuinely busier for a café; Monday is the quietest day.
    const weekendLift = weekday === 0 || weekday === 6 ? 1.25 : weekday === 1 ? 0.88 : 1.0;

    // PLANTED #2 — Diwali. A symmetric ramp around the peak, so the spike has a visible run-up and
    // fall-off rather than appearing as a single anomalous day.
    const distanceFromDiwali = Math.abs(daysAgo - DIWALI.peakDaysAgo);
    const diwaliLift =
      distanceFromDiwali <= DIWALI.spreadDays
        ? 1 + (DIWALI.peakMultiplier - 1) * (1 - distanceFromDiwali / (DIWALI.spreadDays + 1))
        : 1;

    /**
     * A PER-STORE-PER-DAY stream, derived from the seed and this day's own key — never the shared
     * sequential `rng`. See Rng.derive: a shared generator makes every day depend on how many draws
     * preceded it, so a run crossing midnight (the corpus anchors dates to generation time) covers a
     * different set of days and shifts every subsequent day's output. Keying on the calendar DATE
     * rather than `daysAgo` is what makes a given day's data stable across runs on different days.
     */
    const dayRng = rng.derive(`${store.code}:${date}`);

    const items = MENU_ITEMS.map((menu) => {
      const base = menu.flagshipPerDay * store.salesScale * weekendLift * diwaliLift;
      const units = Math.max(0, Math.round(base * dayRng.float(0.82, 1.18, 4)));
      return { externalId: posIdByMenuName.get(menu.name)!, posName: menu.posName, menuName: menu.name, unitPrice: menu.price, units };
    }).filter((i) => i.units > 0);

    for (const nonMenu of NON_MENU_POS_ITEMS) {
      const units = Math.max(0, Math.round(nonMenu.flagshipPerDay * store.salesScale * dayRng.float(0.7, 1.3, 4)));
      // A parcel charge rides along with food, so it is classified as a snack-hour item rather than
      // getting its own curve.
      if (units > 0) items.push({ externalId: nonMenu.externalId, posName: nonMenu.name, menuName: 'parcel snack', unitPrice: nonMenu.price, units });
    }

    days.push({ date, daysAgo, items });
    // Receipt-level only for the recent window — see RECEIPT_LEVEL_DAYS for why this is split.
    if (daysAgo <= RECEIPT_LEVEL_DAYS) {
      allReceipts.push(...buildReceiptsForDay({ rng: dayRng, store, date, daysAgo, itemUnits: items, seq }));
    }
  }

  dayUnitsByStore.set(store.code, days);
}

for (const store of STORES) {
  const storeReceipts = allReceipts.filter((r) => r.storeCode === store.code);
  write(`sales/receipts-${store.code.toLowerCase()}.json`, storeReceipts);
}

/**
 * Older history as daily per-item aggregates. The seeder writes these as one real sale per
 * item/day — still through the real ingestion pipeline, just at day granularity instead of
 * receipt granularity, which is what keeps 180 days of trend data affordable to seed.
 */
write('sales/daily-aggregates.json', STORES.flatMap((store) =>
  (dayUnitsByStore.get(store.code) ?? [])
    .filter((d) => d.daysAgo > RECEIPT_LEVEL_DAYS)
    .map((d) => ({
      storeCode: store.code,
      date: isoDate(d.date),
      daysAgo: d.daysAgo,
      items: d.items.map((i) => ({ externalId: i.externalId, posName: i.posName, units: i.units, unitPrice: i.unitPrice })),
    }))
));

/** A day-level rollup for quick inspection, spanning BOTH fidelities. */
write('sales/daily-summary.json', STORES.flatMap((store) =>
  (dayUnitsByStore.get(store.code) ?? []).map((d) => ({
    storeCode: store.code,
    date: isoDate(d.date),
    daysAgo: d.daysAgo,
    fidelity: d.daysAgo <= RECEIPT_LEVEL_DAYS ? 'receipts' : 'aggregate',
    units: d.items.reduce((n, i) => n + i.units, 0),
    receipts: allReceipts.filter((r) => r.storeCode === store.code && r.daysAgo === d.daysAgo).length,
  }))
));

/* ------------------------------------------------------------------ findings */

// Written AFTER the corpus so every documented figure is measured from what was actually emitted.
mkdirSync(join(ROOT, 'findings'), { recursive: true });
writeFileSync(
  join(ROOT, 'findings/planted-findings.md'),
  buildFindingsDoc({
    seed: CORPUS_SEED,
    invoices,
    receipts: allReceipts,
    products: PRODUCTS,
    menuItems: MENU_ITEMS,
    suppliers: SUPPLIERS,
    stores: STORES,
    diwaliPeakDaysAgo: DIWALI.peakDaysAgo,
    pdfCount: invoices.length,
    tradingDaysByStore: new Map(STORES.map((s) => [s.code, (dayUnitsByStore.get(s.code) ?? []).length])),
  }),
  'utf8'
);

/* ------------------------------------------------------------------ meta */

write('meta.json', {
  seed: CORPUS_SEED,
  generatedAt: generatedAt.toISOString(),
  historyDays: HISTORY_DAYS,
  organization: ORGANIZATION,
  receiptLevelDays: RECEIPT_LEVEL_DAYS,
  /**
   * Emitted in FULL, not projected down to a few fields. The corpus has to be self-describing: a
   * seeder reading it must not have to reach back into the generator's TypeScript for a store's
   * timezone or address. Projecting `timezone` away is exactly what made the first seed run fail on
   * a NOT NULL constraint — the reader had no source for a value it genuinely needed.
   */
  stores: STORES,
  staff: STAFF,
  counts: {
    products: PRODUCTS.length,
    menuItems: MENU_ITEMS.length,
    suppliers: SUPPLIERS.length,
    invoices: invoices.length,
    receipts: allReceipts.length,
    receiptLines: allReceipts.reduce((n, r) => n + r.lines.length, 0),
    voided: allReceipts.filter((r) => r.status === 'VOIDED').length,
  },
});

console.log(JSON.stringify({
  ok: true,
  products: PRODUCTS.length,
  menuItems: MENU_ITEMS.length,
  suppliers: SUPPLIERS.length,
  invoices: invoices.length,
  receipts: allReceipts.length,
  receiptLines: allReceipts.reduce((n, r) => n + r.lines.length, 0),
}, null, 2));
