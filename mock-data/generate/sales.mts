/**
 * Real POS receipts — individual transactions, not daily aggregates.
 *
 * An aggregate ("Indiranagar sold 120 filter coffees on Tuesday") is convenient for a generator and
 * wrong for a demo: it has no timestamps, so no daypart analysis is possible; no payment modes, so
 * the settlement mix is invisible; no order identity, so nothing can be reconciled or voided. This
 * emits what a real Indian café POS export actually contains.
 *
 * What makes it realistic:
 *  - **Intra-day peaks.** A Bengaluru café has a hard 08:00-10:30 breakfast rush, a lunch bump, and
 *    a 16:00-18:30 chai/coffee peak. Flat hourly distribution is the single most obvious tell of
 *    fake data.
 *  - **Item-appropriate timing.** Idli and dosa sell at breakfast; biryani at lunch; chai all day
 *    with an evening spike. A masala dosa at 21:00 is not impossible, but it is not the mode.
 *  - **Payment mix.** UPI dominates (~65%), then card, then cash — the real Indian split post-2020.
 *  - **GST on sales.** Restaurant supply is 5% (2.5% CGST + 2.5% SGST), charged on the receipt.
 *  - **Basket behaviour.** People buy a coffee AND a snack. One-item receipts exist, but a real
 *    average basket is 1.8-2.4 lines.
 *  - **Voids and discounts.** Every real trading day has a few.
 */
import type { Rng } from './rng.mts';
import type { MenuItemSpec } from './catalog.mts';
import type { StoreSpec } from './stores.mts';
import { mulPackPrice, sumMoney, mulBasisPoints } from './money.mts';

/** GST on restaurant supply: 5% total, split evenly intra-state. */
export const SALES_GST_BASIS_POINTS = 500;

export type PaymentMode = 'UPI' | 'CARD' | 'CASH';

/** Real post-2020 Indian café settlement mix. UPI is dominant; cash has not vanished. */
const PAYMENT_WEIGHTS: { mode: PaymentMode; weight: number }[] = [
  { mode: 'UPI', weight: 65 },
  { mode: 'CARD', weight: 20 },
  { mode: 'CASH', weight: 15 },
];

/**
 * When each menu item actually sells, as hour-of-day weights (06:00-22:00).
 * Keyed by a coarse "kind" so a new menu item only needs classifying, not a bespoke curve.
 */
type DayPartProfile = 'breakfast' | 'allDayBeverage' | 'lunch' | 'snack' | 'evening';

const HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21] as const;

const HOUR_WEIGHTS: Record<DayPartProfile, number[]> = {
  //            6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21
  breakfast: [  2, 10, 22, 24, 16,  8,  4,  3,  2,  2,  2,  2,  1,  1,  1,  0],
  allDayBeverage: [3, 8, 12, 12,  8,  6,  5,  5,  4,  5,  9, 11,  8,  5,  4,  2],
  lunch: [       0,  0,  1,  2,  3,  8, 20, 24, 16,  8,  5,  4,  4,  3,  2,  0],
  snack: [       1,  3,  6,  8,  7,  6,  6,  6,  5,  7, 12, 14, 10,  5,  3,  1],
  evening: [     0,  1,  2,  3,  3,  4,  5,  5,  4,  6, 12, 16, 14,  9,  5,  2],
};

/** Classify a menu item by name — the corpus's own vocabulary, no external mapping needed. */
export const dayPartFor = (name: string): DayPartProfile => {
  const n = name.toLowerCase();
  if (/idli|vada|dosa|upma|pongal/.test(n)) return 'breakfast';
  if (/coffee|chai|cappuccino|milk|soda|shake/.test(n)) return 'allDayBeverage';
  if (/biryani|rice|paneer butter/.test(n)) return 'lunch';
  if (/puff|sandwich|roll/.test(n)) return 'snack';
  return 'evening';
};

export interface ReceiptLine {
  externalId: string;
  posName: string;
  qty: number;
  unitPrice: string;
  lineTotal: string;
}

export interface Receipt {
  /** The POS's own order id — what a real export keys on and what idempotent re-import dedupes by. */
  externalId: string;
  storeCode: string;
  /** Full ISO timestamp, in the store's local trading hours. */
  occurredAt: string;
  daysAgo: number;
  lines: ReceiptLine[];
  subtotal: string;
  discount: string;
  cgst: string;
  sgst: string;
  total: string;
  paymentMode: PaymentMode;
  status: 'COMPLETED' | 'VOIDED';
}

const pickPayment = (rng: Rng): PaymentMode => {
  const total = PAYMENT_WEIGHTS.reduce((n, p) => n + p.weight, 0);
  let roll = rng.next() * total;
  for (const { mode, weight } of PAYMENT_WEIGHTS) {
    roll -= weight;
    if (roll <= 0) return mode;
  }
  return 'UPI';
};

/** Weighted hour pick for a given daypart profile. */
const pickHour = (rng: Rng, profile: DayPartProfile): number => {
  const weights = HOUR_WEIGHTS[profile];
  const total = weights.reduce((n, w) => n + w, 0);
  let roll = rng.next() * total;
  for (let i = 0; i < HOURS.length; i++) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) return HOURS[i]!;
  }
  return 12;
};

/**
 * Expands a day's per-item unit totals into individual receipts.
 *
 * Items are placed into their real selling hours first, then grouped into baskets WITHIN the same
 * hour — because a receipt is one customer at one moment, and a basket spanning 09:00 and 17:00
 * would be nonsense. Leftover single items become one-line receipts, which is also realistic.
 */
export const buildReceiptsForDay = (input: {
  rng: Rng;
  store: StoreSpec;
  date: Date;
  daysAgo: number;
  /** Per-item units sold that day, already scaled for store size, weekday and festival lift. */
  itemUnits: { externalId: string; posName: string; menuName: string; unitPrice: string; units: number }[];
  seq: () => number;
}): Receipt[] => {
  const { rng, store, date, daysAgo, itemUnits, seq } = input;

  // Bucket every individual unit into the hour it plausibly sold in.
  const byHour = new Map<number, { externalId: string; posName: string; unitPrice: string }[]>();
  for (const item of itemUnits) {
    const profile = dayPartFor(item.menuName);
    for (let i = 0; i < item.units; i++) {
      const hour = pickHour(rng, profile);
      const list = byHour.get(hour) ?? [];
      list.push({ externalId: item.externalId, posName: item.posName, unitPrice: item.unitPrice });
      byHour.set(hour, list);
    }
  }

  const receipts: Receipt[] = [];

  for (const [hour, units] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    const shuffled = rng.shuffle(units);
    let cursor = 0;

    while (cursor < shuffled.length) {
      // Real basket sizes: mostly 1-3 lines, occasionally larger for a group order.
      const basketSize = Math.min(shuffled.length - cursor, rng.chance(0.12) ? rng.int(4, 6) : rng.int(1, 3));
      const picked = shuffled.slice(cursor, cursor + basketSize);
      cursor += basketSize;

      // Collapse duplicate SKUs in one basket into a single line with qty > 1 — two coffees on one
      // receipt is one line, not two, exactly as a real till prints it.
      const byItem = new Map<string, ReceiptLine>();
      for (const unit of picked) {
        const existing = byItem.get(unit.externalId);
        if (existing) {
          existing.qty += 1;
          existing.lineTotal = mulPackPrice(String(existing.qty), existing.unitPrice);
        } else {
          byItem.set(unit.externalId, {
            externalId: unit.externalId,
            posName: unit.posName,
            qty: 1,
            unitPrice: unit.unitPrice,
            lineTotal: mulPackPrice('1', unit.unitPrice),
          });
        }
      }
      const lines = [...byItem.values()];
      const subtotal = sumMoney(lines.map((l) => l.lineTotal));

      // A small share of receipts carry a real discount (loyalty, staff, a promo).
      const discount = rng.chance(0.06) ? mulBasisPoints(subtotal, rng.pick([500, 1000, 1500])) : '0.0000';
      // GST is charged on the DISCOUNTED value, which is what the law and every real till do —
      // taxing the pre-discount amount would overstate both the tax and the receipt total.
      const taxableBase = subtractMoney(subtotal, discount);

      const cgst = mulBasisPoints(taxableBase, SALES_GST_BASIS_POINTS / 2);
      const sgst = cgst;

      const minute = rng.int(0, 59);
      const second = rng.int(0, 59);
      const occurredAt = new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute, second)
      );

      receipts.push({
        externalId: `${store.code}-${occurredAt.toISOString().slice(0, 10).replace(/-/g, '')}-${String(seq()).padStart(5, '0')}`,
        storeCode: store.code,
        occurredAt: occurredAt.toISOString(),
        daysAgo,
        lines,
        subtotal,
        discount,
        cgst,
        sgst,
        total: sumMoney([taxableBase, cgst, sgst]),
        paymentMode: pickPayment(rng),
        // A genuinely voided receipt on ~0.4% of orders — mis-punched, cancelled before serving.
        status: rng.chance(0.004) ? 'VOIDED' : 'COMPLETED',
      });
    }
  }

  return receipts;
};

/** Exact 4dp subtraction. `sumMoney` only adds, and a negative-string hack would be fragile. */
export const subtractMoney = (a4dp: string, b4dp: string): string => {
  const toScaled = (v: string): bigint => {
    const [i = '0', f = ''] = v.split('.');
    return BigInt(i + f.padEnd(4, '0').slice(0, 4));
  };
  const diff = toScaled(a4dp) - toScaled(b4dp);
  const neg = diff < 0n;
  const s = (neg ? -diff : diff).toString().padStart(5, '0');
  return `${neg ? '-' : ''}${s.slice(0, -4)}.${s.slice(-4)}`;
};
