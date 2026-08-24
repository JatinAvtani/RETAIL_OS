/**
 * The three Bengaluru outlets, and the staff who can see them.
 *
 * Sizes differ DELIBERATELY and substantially. Three near-identical outlets make the store
 * comparison view pointless — every column reads the same and there is nothing to notice. A
 * flagship, a mid-size outlet, and a small ramping one give the manager view a real question to
 * answer ("why is Koramangala's margin worse?").
 *
 * `salesScale` is a multiplier on the flagship's per-item daily volume. Note it is staggered, not
 * tripled: total ledger volume across three outlets lands near 2.0x a single store, not 3.0x. Every
 * seeded sale line runs the real ingestion pipeline (recipe explosion + FEFO draw + movement
 * posting), so volume is the main driver of both seed time and memory — and this machine has hit
 * genuine OOM under load before.
 */

export interface StoreSpec {
  code: string;
  name: string;
  address: string;
  timezone: string;
  /** Multiplier against MenuItemSpec.flagshipPerDay. */
  salesScale: number;
  /** Opens partway through the window — a genuinely newer outlet with a shorter history. */
  opensDaysAgo: number;
  role: 'flagship' | 'mid' | 'small';
}

export const STORES: StoreSpec[] = [
  {
    code: 'IND',
    name: 'Indiranagar',
    address: '221, 100 Feet Road, Indiranagar, Bengaluru 560038',
    timezone: 'Asia/Kolkata',
    salesScale: 1.0,
    opensDaysAgo: 180,
    role: 'flagship',
  },
  {
    code: 'JAY',
    name: 'Jayanagar',
    address: '55, 11th Main, 4th Block, Jayanagar, Bengaluru 560011',
    timezone: 'Asia/Kolkata',
    salesScale: 0.62,
    opensDaysAgo: 180,
    role: 'mid',
  },
  {
    /**
     * PLANTED FINDING #5 — the underperforming outlet. Koramangala opens 95 days in (genuinely
     * newer, so a shorter history is honest) AND carries a deliberately worse contribution margin,
     * driven by real causes the data can explain: heavier discounting on beverages and a higher
     * wastage rate, not an arbitrary number. The manager view should make it visibly worse than
     * the other two.
     */
    code: 'KOR',
    name: 'Koramangala',
    address: '12, 80 Feet Road, 4th Block, Koramangala, Bengaluru 560034',
    timezone: 'Asia/Kolkata',
    salesScale: 0.38,
    opensDaysAgo: 95,
    role: 'small',
  },
];

/**
 * Memberships exercise the real authz model rather than making everyone an owner:
 *  - the OWNER sees all three outlets (`storeIds: 'ALL'`)
 *  - a MANAGER is scoped to ONE outlet only, so store-scoped access checks have something real to
 *    enforce and a demo can show a genuine permission boundary instead of asserting one exists.
 */
export interface StaffSpec {
  email: string;
  name: string;
  role: 'OWNER' | 'MANAGER';
  /** null = all stores; otherwise the store code this person is scoped to. */
  storeCode: string | null;
  approvalLimit?: string;
}

export const STAFF: StaffSpec[] = [
  { email: 'demo@vyapaar.test', name: 'Ananya Rao', role: 'OWNER', storeCode: null, approvalLimit: '200000.0000' },
  { email: 'manager.koramangala@vyapaar.test', name: 'Vikram Shetty', role: 'MANAGER', storeCode: 'KOR', approvalLimit: '25000.0000' },
];

export const ORGANIZATION = {
  name: 'Third Wave Bengaluru',
  slug: 'third-wave-bengaluru',
  baseCurrency: 'INR',
} as const;

/** The corpus window. Every date in the corpus is computed as an offset from generation time, never a hardcoded absolute — so the demo never "expires" into the past. */
export const HISTORY_DAYS = 180;

/**
 * Sales are stored at two fidelities, deliberately.
 *
 * The last `RECEIPT_LEVEL_DAYS` are INDIVIDUAL TIMESTAMPED RECEIPTS — real order ids, intra-day
 * peaks, UPI/card/cash mix, GST, multi-line baskets, the occasional void. Everything older is a
 * DAILY AGGREGATE per item.
 *
 * Why split rather than pick one: full receipt fidelity across 180 days generates ~162k receipts /
 * ~344k lines (107 MB). Every one of those lines must run through the real ingestion pipeline
 * (recipe explosion -> FEFO draw -> movement posting) because this project forbids raw inserts —
 * which is hours of seeding and a genuine OOM risk on the dev machine. Aggregates for older history
 * keep trend lines, margin and cost variance completely intact, since those read summed values
 * anyway; nothing that reads a 90- or 180-day window loses information.
 *
 * 45 days covers every default dashboard window (7/30 day), the daypart views, and the POS screens
 * — i.e. everything a user actually opens sees genuine receipt-level data.
 */
export const RECEIPT_LEVEL_DAYS = 45;

/**
 * PLANTED FINDING #2 — Diwali. Placed at a fixed offset inside the window rather than a real
 * calendar date, because the corpus is regenerated relative to "now": pinning it to an actual
 * Diwali date would drift out of the window entirely within a year.
 */
export const DIWALI = {
  /** Peak day, counted back from today. */
  peakDaysAgo: 52,
  /** Days either side of the peak that also see elevated demand. */
  spreadDays: 6,
  /** Peak-day multiplier on normal volume. */
  peakMultiplier: 2.4,
} as const;
