/**
 * Emits `findings/planted-findings.md` with figures MEASURED from the corpus that was just
 * generated — never hand-written constants.
 *
 * This matters more than it looks. The first version of the price-creep narrative documented an
 * intended "+13%" while the generator actually produced +9.75%, because the top creep step was
 * unreachable. A hand-maintained findings doc would have shipped that wrong number as the expected
 * value, and every later verification would have been checked against a lie. Deriving the figures
 * from the emitted data means the doc cannot drift from the corpus it describes.
 */
import type { CatalogProduct, MenuItemSpec } from './catalog.mts';
import type { SupplierSpec } from './suppliers.mts';
import type { StoreSpec } from './stores.mts';

interface InvoiceLineLike { sku: string; unitPrice: string }
interface InvoiceLike { supplierCode: string; date: string; lines: InvoiceLineLike[] }
/** A real receipt, as emitted into sales/receipts-*.json. */
interface ReceiptLike {
  daysAgo: number;
  storeCode: string;
  status: 'COMPLETED' | 'VOIDED';
  total: string;
  paymentMode: string;
  lines: { qty: number }[];
}

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
};

export const buildFindingsDoc = (input: {
  seed: number;
  invoices: InvoiceLike[];
  receipts: ReceiptLike[];
  products: CatalogProduct[];
  menuItems: MenuItemSpec[];
  suppliers: SupplierSpec[];
  stores: StoreSpec[];
  diwaliPeakDaysAgo: number;
  pdfCount: number;
  /** Trading days per store code across the WHOLE window — receipts alone only cover the recent slice, so measuring history from them would wrongly report every outlet as equally new. */
  tradingDaysByStore: Map<string, number>;
}): string => {
  const { seed, invoices, receipts, products, menuItems, suppliers, stores, diwaliPeakDaysAgo, pdfCount, tradingDaysByStore } = input;
  /** Voided receipts are excluded from every business figure — a void is not a sale. */
  const sold = receipts.filter((r) => r.status === 'COMPLETED');

  /* ---- 1. price creep, measured per SKU ---- */
  const creepSupplier = suppliers.find((s) => s.priceCreepBasisPoints);
  const creepRows: { sku: string; name: string; n: number; first: number; last: number; pct: number }[] = [];
  if (creepSupplier) {
    const bySku = new Map<string, { date: string; price: number }[]>();
    for (const inv of invoices) {
      if (inv.supplierCode !== creepSupplier.code) continue;
      for (const line of inv.lines) {
        const list = bySku.get(line.sku) ?? [];
        list.push({ date: inv.date, price: Number(line.unitPrice) });
        bySku.set(line.sku, list);
      }
    }
    for (const [sku, rows] of bySku) {
      rows.sort((a, b) => (a.date < b.date ? -1 : 1));
      const first = rows[0]!.price;
      const last = rows[rows.length - 1]!.price;
      creepRows.push({
        sku,
        name: products.find((p) => p.sku === sku)?.name ?? sku,
        n: rows.length,
        first,
        last,
        pct: first === 0 ? 0 : (last / first - 1) * 100,
      });
    }
    creepRows.sort((a, b) => b.pct - a.pct);
  }
  const maxCreep = creepRows.length > 0 ? creepRows[0]!.pct : 0;

  /* ---- 2. Diwali spike, measured at the flagship ---- */
  const flagship = stores.find((s) => s.role === 'flagship')!;
  const unitsByDay = new Map<number, number>();
  for (const receipt of sold) {
    if (receipt.storeCode !== flagship.code) continue;
    const units = receipt.lines.reduce((n, l) => n + l.qty, 0);
    unitsByDay.set(receipt.daysAgo, (unitsByDay.get(receipt.daysAgo) ?? 0) + units);
  }
  const peakUnits = unitsByDay.get(diwaliPeakDaysAgo) ?? 0;
  const baselineUnits = median([...unitsByDay.entries()].filter(([d]) => Math.abs(d - diwaliPeakDaysAgo) > 12).map(([, u]) => u));
  const diwaliLift = baselineUnits === 0 ? 0 : peakUnits / baselineUnits;
  const ramp = [60, 57, 54, diwaliPeakDaysAgo, 50, 48, 45]
    .map((d) => `daysAgo=${String(d).padStart(2)}   ${String(unitsByDay.get(d) ?? 0).padStart(5)}${d === diwaliPeakDaysAgo ? '     <- PEAK' : ''}`)
    .join('\n');

  /* ---- 5. per-outlet revenue, last 30 days ---- */
  const outlet = stores.map((store) => {
    const mine = sold.filter((r) => r.storeCode === store.code);
    const recent = mine.filter((r) => r.daysAgo <= 30);
    return {
      name: store.name,
      role: store.role,
      revenue: recent.reduce((n, r) => n + Number(r.total), 0),
      units: recent.reduce((n, r) => n + r.lines.reduce((m, l) => m + l.qty, 0), 0),
      receipts: recent.length,
      historyDays: tradingDaysByStore.get(store.code) ?? 0,
    };
  });
  const totalRevenue = outlet.reduce((n, o) => n + o.revenue, 0);

  /* ---- payment mix, measured ---- */
  const payMix = new Map<string, number>();
  for (const r of sold) payMix.set(r.paymentMode, (payMix.get(r.paymentMode) ?? 0) + 1);
  const payTotal = [...payMix.values()].reduce((n, v) => n + v, 0);
  const voidCount = receipts.length - sold.length;

  /* ---- 6. the I7 anchor ---- */
  const unpriced = products.find((p) => p.deliberatelyUnpriced);
  const affectedItems = unpriced ? menuItems.filter((m) => m.components.some((c) => c.sku === unpriced.sku)) : [];

  const inr = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 0 });

  return `# Planted findings

> **Generated file — do not hand-edit.** Emitted by \`generate/findings.mts\` with every figure
> MEASURED from the corpus it describes, so the documented numbers cannot drift from the data.

Every narrative deliberately built into this corpus, with its expected figure. If a figure below
does not match what the app shows, that is a real discrepancy worth investigating — which is the
entire point of writing them down.

All figures are for \`seed = ${seed}\`. **Changing the seed changes every number on this page.**

Regenerate with:

\`\`\`
pnpm --filter @retailos/api exec tsx ../../mock-data/generate/generate.mts
\`\`\`

Status: **in corpus** = present in the generated data now · **needs Part 2** = requires domains
(goods receipts, wastage, transfers) not yet seeded.

---

## 1. Supplier price creep — ${creepSupplier?.name ?? 'n/a'} · **in corpus**

The dry-goods supplier ratchets prices upward across the window, applied as **four discrete steps**
rather than a smooth ramp: \`detectPriceChange\` only fires when a change crosses its threshold, so a
continuous +0.1% drift would be a real trend that never triggers a single event.

**Measured on the generated corpus (top movers):**

| SKU | Invoices | First | Last | Observed change |
|---|---|---|---|---|
${creepRows.slice(0, 8).map((r) => `| \`${r.sku}\` ${r.name} | ${r.n} | ${r.first.toFixed(2)} | ${r.last.toFixed(2)} | **${r.pct >= 0 ? '+' : ''}${r.pct.toFixed(1)}%** |`).join('\n')}

Maximum observed creep: **+${maxCreep.toFixed(1)}%** (target ≈ ${((creepSupplier?.priceCreepBasisPoints ?? 0) / 100).toFixed(1)}%).

Lower per-SKU figures are **honest, not defects**: those products do not appear on the newest
invoices, so their observed creep genuinely stops at an earlier step. A price history can only show
what was actually invoiced.

**Where to see it:** Supplier scorecard (${creepSupplier?.name ?? ''}) · price-change events ·
first-finding report.

---

## 2. Diwali demand spike · **in corpus**

A festival surge with a genuine run-up and fall-off, not one anomalous day. Peak at
\`daysAgo = ${diwaliPeakDaysAgo}\`.

**Measured at the flagship (${flagship.name}), total units/day:**

\`\`\`
${ramp}
\`\`\`

- Normal median: **${inr(Math.round(baselineUnits))} units/day**
- Peak: **${inr(peakUnits)} units/day**
- **Observed lift: ${diwaliLift.toFixed(2)}×**

**Where to see it:** dashboard sales trend · sparklines · any 90-day window.

---

## 3. Wastage / expiry cluster · **needs Part 2**

Planned on a short-shelf-life perishable (paneer, 6-day expiry; or coriander, 4-day). Requires real
waste movements, which Part 2 seeds.

---

## 4. Supplier reliability decline — ${suppliers.find((s) => s.reliabilityDecline)?.name ?? 'n/a'} · **needs Part 2**

Flagged in \`suppliers.mts\`. Produce is the deliberate choice: short shelf life means a late
delivery has a visible operational consequence. Expressing it requires **goods receipts** with real
short-deliveries and late arrivals — Part 2.

---

## 5. Outlet underperforming on contribution margin — ${stores.find((s) => s.role === 'small')?.name ?? ''} · **partly in corpus**

**Measured, last 30 days:**

| Outlet | Revenue (INR, incl. GST) | Receipts | Units | History |
|---|---|---|---|---|
${outlet.map((o) => `| ${o.name} (${o.role}) | ${inr(o.revenue)} | ${inr(o.receipts)} | ${inr(o.units)} | ${o.historyDays} days |`).join('\n')}

Volume differentiation and the genuinely shorter history are in the corpus. The **margin**
underperformance needs Part 2's wastage and discounting to become real rather than merely smaller.

---

## 6. Genuinely unknown cost (I7 anchor) · **in corpus**

\`${unpriced?.sku ?? ''}\` (${unpriced?.name ?? ''}) is deliberately left with **no supplier mapping
and no confirmed price**, so ${affectedItems.map((m) => `**${m.name}**`).join(', ')} resolves to a
real *unknown* cost while every other item costs correctly.

This is the load-bearing honesty demo: "unknown, never zero" must be **visible on screen**, not just
asserted in a test. **Do not price this product to make the dataset look complete** — a demo where
every number resolves proves nothing about how missing data is handled.

**Where to see it:** Recipes → ${affectedItems[0]?.name ?? ''} (cost shows *Not known*) · dashboard
data completeness panel.

---

## Corpus totals

| Metric | Value |
|---|---|
| Products | ${products.length} |
| Menu items | ${menuItems.length} |
| Suppliers | ${suppliers.length} |
| GST tax invoices | ${invoices.length} (with ${pdfCount} PDFs) |
| POS receipts | ${inr(receipts.length)} (${inr(voidCount)} voided) |
| Receipt lines | ${inr(sold.reduce((n, r) => n + r.lines.length, 0))} |
| Revenue, last 30d, all outlets | INR ${inr(totalRevenue)} |

### Payment mix (measured, all completed receipts)

| Mode | Receipts | Share |
|---|---|---|
${[...payMix.entries()].sort((a, b) => b[1] - a[1]).map(([mode, n]) => `| ${mode} | ${inr(n)} | ${((n / payTotal) * 100).toFixed(1)}% |`).join('\n')}

Reflects the real post-2020 Indian café settlement mix: UPI dominant, card second, cash still
present. Voided receipts are excluded from every business figure above — a void is not a sale.
`;
};
