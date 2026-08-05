import type { CurrencyCode } from '@retailos/domain';

/**
 * 006-02 (plan.md Phase 1, spec 13 §13.3): "The canonical model is designed from two vendors'
 * shapes, not one — designing it against Square alone guarantees a leaky abstraction that Toast
 * breaks." Researched both real API shapes before writing this file (only Square ships in this
 * MVP; Toast is V2, per task.md).
 *
 * The load-bearing structural fact: Square's `Order` is a flat `LineItem[]` — one order, one set
 * of tenders, one payment surface. Toast's `Order` is `Check[] → Selection[]` — a single order can
 * legitimately settle as MULTIPLE independent payments against MULTIPLE checks (a table split),
 * and a `Selection`'s modifiers are themselves `Selection`s, recursively nested (3+ levels deep is
 * normal — a modifier can have its own modifier). A canonical model built only from Square's shape
 * hard-codes "one order = one bill" and flattens modifiers into a sibling array — both assumptions
 * break the moment Toast's real shape has to fit through it.
 *
 * `ExternalTransaction` below is deliberately the Square-shaped "one order, one payment surface"
 * case is a `checks.length === 1` special case of the general Order→Check→Line shape, not the
 * other way around — an adapter mapping FROM the simpler vendor into the richer canonical shape is
 * a lossless widening; the reverse (designing canonical-flat, then trying to fit Toast's checks
 * into it) is the lossy flattening this whole exercise exists to avoid.
 */
/**
 * Deliberately wider than `sales_source` (`packages/db`'s real Postgres enum, 006-01):
 * `sales_source` only has `'square'|'csv'` — CSV is the other thing that actually writes a row in
 * this MVP, not Toast. `'toast'` exists here only so this interface can be typed against Toast's
 * real shape now, per plan.md's explicit instruction, without a Toast adapter or a Toast database
 * row ever needing to exist. If a real Toast adapter ships later (V2), `sales_source` gains a
 * migration-added enum value at that point — this type doesn't need to change.
 */
export type PosVendor = 'square' | 'toast';

/**
 * Money crosses the vendor boundary as a plain, unbranded string here deliberately — Square
 * represents money as integer minor-unit cents, Toast as decimal dollar strings; converting either
 * into this codebase's real `Money` branded type (I5) is the ADAPTER's job at the moment it maps a
 * raw vendor payload into this canonical shape, never left for a caller further downstream to
 * guess at. This type exists to describe "the adapter has already normalized this", not to BE the
 * normalization boundary itself.
 */
export type ExternalMoney = {
  amount: string;
  currency: CurrencyCode;
};

export type ExternalLocation = {
  externalId: string;
  name: string;
  timezone: string;
};

/**
 * One sellable catalog entry. Mirrors the real shape both vendors actually use, not a simplified
 * fiction: Square's `CatalogObject` (type=ITEM) has NO price of its own — every priced, orderable
 * thing is a nested `ITEM_VARIATION` with its own SKU; Toast's `MenuItem` similarly has optional
 * `portions` as its size-variant mechanism. A product with only one real SKU still gets exactly one
 * variation row here — never collapsed to a variation-less item — so `pos_items` (006-01) always
 * has one predictable shape to upsert into, regardless of vendor.
 */
export type ExternalCatalogItem = {
  externalId: string;
  name: string;
  category?: string;
  variations: ExternalCatalogItemVariation[];
};

export type ExternalCatalogItemVariation = {
  externalId: string;
  name: string;
  sku?: string;
  price?: ExternalMoney;
};

/**
 * A modifier applied to a line. Self-referential, not a flat leaf type — Toast's real shape
 * nests modifiers-of-modifiers (a "no pickles" modifier can itself carry a "charge as extra"
 * sub-modifier); Square's flatter `OrderLineItemModifier[]` is the `modifiers: []` (empty) case of
 * this same shape, not a different shape needing a separate type.
 */
export type ExternalModifier = {
  externalId: string;
  name: string;
  priceAdjustment?: ExternalMoney;
  modifiers: ExternalModifier[];
};

/**
 * One item ordered within a line. `posItemExternalId` points at a specific
 * `ExternalCatalogItemVariation.externalId` (never the parent item) — matching both vendors' own
 * convention that an order line always references the priced, orderable variation, not its parent
 * grouping.
 */
export type ExternalTransactionLine = {
  externalId: string;
  posItemExternalId: string;
  name: string;
  quantity: string;
  unitPrice: ExternalMoney;
  discount: ExternalMoney;
  lineTotal: ExternalMoney;
  modifiers: ExternalModifier[];
  voided: boolean;
};

/**
 * One independently-payable billing unit within a transaction. For Square this is always exactly
 * one per transaction (Square has no sub-order payment splitting) — the adapter still wraps it in
 * a single-element `checks` array rather than special-casing the flat shape at the canonical-model
 * level, so every downstream consumer of `ExternalTransaction` handles exactly one shape, not two.
 */
export type ExternalCheck = {
  externalId: string;
  lines: ExternalTransactionLine[];
  subtotal: ExternalMoney;
  discount: ExternalMoney;
  tax: ExternalMoney;
  total: ExternalMoney;
};

export type ExternalTransactionStatus = 'completed' | 'refunded' | 'voided';

/**
 * The order/transaction as a whole. `refundOfExternalId` mirrors both vendors' own convention of
 * recording a refund as an addition to the original sale's record (Square: `refunds`/`returns`
 * sub-objects on the same order; Toast: a check-level refund/void state) rather than a wholly
 * separate transaction with no back-reference — the adapter's job is to surface that link, not
 * invent a synthetic one.
 *
 * `refundedAmount` (006-08): the TOTAL amount refunded against this order so far — Square's own
 * `refunds[]` array can hold several entries (a merchant partially refunding in stages), so this is
 * always the adapter's own SUM of every refund entry's amount, not one entry's amount. Undefined
 * when nothing has been refunded, never `0.00` (I7 — the absence of this field is itself the "no
 * refund" signal; a caller comparing it against the order's total to compute a reversal fraction
 * must not default a missing value to zero in a way that could silently mask a real refund this
 * adapter failed to parse). `status: 'refunded'` mirrors a FULL refund (fraction === 1); a partial
 * refund keeps `status: 'completed'` with `refundedAmount` set below the order's own total — the
 * caller computes the fraction from the two, this type just carries the raw fact.
 */
export type ExternalTransaction = {
  externalId: string;
  locationExternalId: string;
  occurredAt: Date;
  channel?: string;
  status: ExternalTransactionStatus;
  refundOfExternalId?: string;
  refundedAmount?: ExternalMoney;
  checks: ExternalCheck[];
};

export type ExternalEventType = 'transaction.updated' | 'catalog.updated';

/**
 * The normalized shape a webhook payload resolves into AFTER `PosAdapter.parseWebhook` — the raw
 * vendor envelope (Square: `event_id`/`type`/`data.object`; Toast: `eventCategory`/`eventType`/a
 * dedup `guid`/the full inline Order JSON) is vendor-specific and never crosses this boundary
 * unparsed. `externalEventId` is the vendor's own dedup key (Square's `event_id`, Toast's `guid`)
 * — the ingestion pipeline (006-06) dedupes on this before ever touching business logic.
 */
export type ExternalEvent = {
  externalEventId: string;
  type: ExternalEventType;
  locationExternalId: string;
  transactionExternalId?: string;
};

export type Page<T> = {
  items: T[];
  nextCursor?: string;
};

/**
 * Opaque per-connection credential/session handle. Never serialized/logged directly by anything
 * outside the adapter that produced it (006-03's job to encrypt at rest, envelope encryption per
 * spec 13 §13.3 — not built here, this is only the shape `authenticate` returns).
 */
export type Connection = {
  vendor: PosVendor;
  externalAccountId: string;
};

/**
 * The adapter contract itself (spec 13 §13.3, plan.md Phase 1's exact sketch). One adapter per
 * vendor; `SquareAdapter` (006-03+) is the only real implementation in this MVP — this interface
 * exists now, validated against Toast's real shape, so THAT implementation doesn't force a
 * breaking change to this contract later (spec's own stated reason for building the abstraction
 * "for the second integration, not the first," but designing it before the first ships anyway).
 */
export interface PosAdapter {
  readonly vendor: PosVendor;
  readonly capabilities: PosAdapterCapabilities;

  authenticate(credentials: unknown): Promise<Connection>;
  fetchLocations(connection: Connection): Promise<ExternalLocation[]>;
  fetchCatalog(connection: Connection, cursor?: string): Promise<Page<ExternalCatalogItem>>;
  fetchTransactions(connection: Connection, since: Date, cursor?: string): Promise<Page<ExternalTransaction>>;
  verifyWebhook(payload: string, signature: string, signingSecret: string): boolean;
  parseWebhook(payload: string): ExternalEvent;
}

/**
 * Lets the UI degrade honestly per vendor (spec 13 §13.3: "if a POS can't report channels, the
 * channel-margin view says 'not available with your POS' rather than showing an empty chart") —
 * never a silent empty result the UI can't distinguish from "genuinely zero."
 */
export type PosAdapterCapabilities = {
  webhooks: boolean;
  modifiers: boolean;
  channels: boolean;
  refunds: boolean;
  costData: boolean;
};
