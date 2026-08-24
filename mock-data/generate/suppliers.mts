/**
 * Suppliers, their GST identity, and which products each one sells.
 *
 * GSTIN format is real: 2-digit state code (29 = Karnataka), 10-char PAN, 1 entity digit, 'Z',
 * 1 checksum char. These are structurally valid but fictional — they belong to no real business.
 *
 * Two suppliers carry PLANTED narratives (see findings/planted-findings.md):
 *   - `priceCreepBasisPoints` — prices ratchet upward across the window, so the price-change
 *     detector and the supplier scorecard have a real trend to surface.
 *   - `reliabilityDecline` — on-time delivery degrades over the last ~60 days, so supplier
 *     performance events describe a supplier genuinely getting worse, not random noise.
 */

/**
 * Invoice layout style. Real suppliers do NOT share a template — a wholesaler's dot-matrix docket
 * and a distributor's printed letterhead look nothing alike, and extraction that only ever sees one
 * layout is not being tested against reality. Each style changes header shape, column order and
 * labelling, while keeping the same underlying GST facts.
 */
export type InvoiceLayout =
  /** Classic Indian wholesaler: boxed header, ornate rules, "Particulars" column, amount in words. */
  | 'wholesaler'
  /** Modern distributor: clean left-aligned letterhead, minimal rules, code-first columns. */
  | 'distributor'
  /** Farm/mandi docket: narrow, terse, no letterhead flourish, weight-led. */
  | 'mandi'
  /** Corporate: right-aligned totals block, explicit tax summary table, remittance footer. */
  | 'corporate';

export interface SupplierSpec {
  code: string;
  name: string;
  gstin: string;
  address: string;
  paymentTerms: string;
  leadTimeDays: number;
  /** How this supplier's invoices are laid out — see InvoiceLayout. */
  layout: InvoiceLayout;
  /** Products this supplier sells, by catalog SKU. */
  skus: string[];
  /**
   * PLANTED: total upward price drift applied across the 180-day window, in basis points
   * (1250 = +12.5%). Applied in steps on real invoices so `detectPriceChange` fires on genuine
   * threshold crossings rather than one artificial jump.
   */
  priceCreepBasisPoints?: number;
  /**
   * PLANTED: when true, this supplier's on-time delivery rate degrades over the final 60 days —
   * early deliveries land on time, later ones slip and short-deliver.
   */
  reliabilityDecline?: boolean;
}

export const SUPPLIERS: SupplierSpec[] = [
  {
    code: 'SBT',
    name: 'Shree Balaji Traders',
    gstin: '29AABCS1429B1ZR',
    address: 'No. 42, Avenue Road, Chickpet, Bengaluru 560053',
    paymentTerms: 'NET30',
    leadTimeDays: 2,
    layout: 'wholesaler',
    skus: ['ATA-WHT', 'MAI-REF', 'RIC-SON', 'RVA-IDL', 'DAL-URD', 'DAL-TUR', 'SUJ-FIN', 'SGR-REF', 'JAG-ORG', 'OIL-SUN', 'SLT-IOD'],
    /**
     * PLANTED FINDING #1 — the staple-goods supplier whose prices creep ~13% over the window.
     * Chosen deliberately as the DRY GOODS supplier: staples are the highest-volume purchases, so
     * the annualised impact figure is large enough to be worth a manager's attention, which is the
     * whole point of surfacing it.
     */
    priceCreepBasisPoints: 1300,
  },
  {
    code: 'NDF',
    name: 'Nandini Dairy Distributors',
    gstin: '29AACCN5512F1ZK',
    address: 'Plot 17, KIADB Industrial Area, Yelahanka, Bengaluru 560064',
    paymentTerms: 'NET15',
    leadTimeDays: 1,
    layout: 'distributor',
    skus: ['MLK-TON', 'CRD-SET', 'PNR-FRS', 'BTR-TBL', 'CHZ-MOZ', 'CRM-FRS', 'GHE-PUR'],
  },
  {
    code: 'GVF',
    name: 'Green Valley Farms',
    gstin: '29AAECG7781M1ZQ',
    address: 'Survey 88, Hoskote Road, Bengaluru Rural 562114',
    paymentTerms: 'NET7',
    leadTimeDays: 1,
    layout: 'mandi',
    skus: ['ONI-RED', 'POT-TAB', 'TOM-HYB', 'CAP-GRN', 'CIL-FRS', 'CUR-LEF', 'GIN-FRS', 'CHL-GRN', 'LEM-FRS', 'BAN-LEF'],
    /**
     * PLANTED FINDING #4 — the produce supplier whose reliability declines. Produce is the right
     * place for this: short shelf life means a late delivery has real operational consequences
     * (a stockout or a wastage spike), so the decline connects to something a user can see.
     */
    reliabilityDecline: true,
  },
  {
    code: 'ACS',
    name: 'Anand Coffee & Spices',
    gstin: '29AADFA3096H1ZB',
    address: '#9, 4th Cross, Malleshwaram, Bengaluru 560003',
    paymentTerms: 'NET30',
    leadTimeDays: 3,
    layout: 'distributor',
    skus: ['CFE-FIL', 'TEA-DUS', 'CFE-ARB', 'MSL-CHA', 'MSL-SAM', 'MSL-GAR', 'TRM-POW', 'MUS-SED'],
  },
  {
    code: 'MPS',
    name: 'Metro Packaging Solutions',
    gstin: '29AAGCM8840L1ZV',
    address: 'Shed 6, Peenya 2nd Stage, Bengaluru 560058',
    paymentTerms: 'NET45',
    leadTimeDays: 4,
    layout: 'corporate',
    skus: ['CUP-PAP', 'BOX-PRC', 'NAP-TIS'],
  },
];

/** The buying organisation's own GST identity, printed as "Bill to" on every supplier invoice. */
export const BUYER = {
  legalName: 'Vyapaar Coffee House Pvt Ltd',
  tradeName: 'Third Wave Bengaluru',
  gstin: '29AAHCV2201N1ZD',
  address: '221, 100 Feet Road, Indiranagar, Bengaluru 560038',
  state: 'Karnataka',
  stateCode: '29',
} as const;
