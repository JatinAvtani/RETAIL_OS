import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Decimal } from 'decimal.js';
import * as schema from '../schema/index';
import { organizations, supplierProducts } from '../schema/index';
import { withTenantContext } from '../tenant-context';
import { PurchaseOrderRepository } from './purchase-order-repository';
import { findReorderSuggestions, type SupplierGroupedSuggestions } from '../purchasing/reorder-suggestions';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** A minimal structural echo of `@retailos/assistant`'s `ActionCandidate`/`DraftActionLine` —
 * `packages/db` cannot depend on `packages/assistant` (the dependency runs the other way: assistant
 * already depends on db), so this module defines its own narrow shape rather than importing one.
 * The `apps/api` caller passes `ActionDraftResult.lines` straight through — the two shapes
 * are kept in sync by that caller's own typecheck, not by a shared import. */
export type ActionCandidate = { candidateId: string; label: string };
export type DraftActionLine = { candidateId: string; label: string; quantity: Decimal; unitLabel: string };

/**
 * the ONLY place an `ActionDraftResult` produced by `planActionDraft`
 * (`@retailos/assistant`) becomes a real `purchase_orders`/`purchase_order_lines` write. Nothing
 * upstream of this file — the model, `planActionDraft`, the investigation loop — ever calls a
 * repository. This function is wired to a UI button's tRPC mutation only, never to any AI
 * tool surface (I9): the model has no path to invoking this, by construction, not by convention.
 *
 * **Candidates are re-derived from real domain state at approval time, not trusted from the
 * draft.** `DraftActionLine.candidateId` is the ONLY thing carried forward from the model's output
 * that this function trusts — `quantity`/`unitLabel` on the draft are for human review in the UI,
 * but the actual `unitPrice`/`conversionToBase`/`supplierProductId`/`productId` written into the PO
 * line come from a fresh `findReorderSuggestions` lookup keyed by that candidateId, exactly the
 * same real function the existing `purchaseOrders.suggestions` router endpoint already calls (I2 —
 * not a second implementation of "what should this line cost/convert to"). A candidateId that no
 * longer resolves (stock moved, the mapping was deleted between draft and approval) is a real
 * rejection, never a best-effort guess from stale draft data.
 */
export type CandidateSourcingResult = {
 candidates: ActionCandidate[];
 /** candidateId -> the real suggestion row it was built from, so `applyApprovedReorderDraft` can
 * re-look-up by the SAME id the model was shown, never a second derivation that could disagree. */
 bySupplierProductId: Map<string, { suggestion: SupplierGroupedSuggestions['suggestions'][number]; supplierId: string; supplierName: string }>;
};

/**
 * Turns the existing, real `findReorderSuggestions` output into the closed candidate list
 * `planActionDraft` is allowed to select from — the model may only pick a `supplierProductId` that
 * genuinely has a real, computed reorder suggestion behind it right now.
 */
export const sourceReorderCandidates = async (
 db: Db,
 organizationId: string,
 storeId: string): Promise<CandidateSourcingResult> => {
 const groups = await findReorderSuggestions(db, organizationId, storeId);
 const bySupplierProductId: CandidateSourcingResult['bySupplierProductId'] = new Map;
 const candidates: ActionCandidate[] = [];

 for (const group of groups) {
 for (const row of group.suggestions) {
 candidates.push({
 candidateId: row.supplierProductId,
 label: `${row.productName} (${row.suggestion.quantity.amount.toDecimalPlaces(2).toString()} ${row.unit ?? ''} suggested) — ${group.supplierName}`,
 });
 bySupplierProductId.set(row.supplierProductId, { suggestion: row, supplierId: group.supplierId, supplierName: group.supplierName });
 }
 }

 return { candidates, bySupplierProductId };
};

export type ApprovalRejection = { candidateId: string; reason: string };

export type ApproveReorderDraftResult =
 | { ok: true; purchaseOrderId: string; rejections: ApprovalRejection[] }
 | { ok: false; reason: string };

/**
 * A real, timestamp-based default — no existing generator to reuse anywhere in this codebase
 * (`poNumber` is otherwise always user-typed at PO-creation time, confirmed by grep before writing
 * this). The approval UI shows this value for the human to review/edit before the final
 * click, same as every other draft field — never silently finalized without being seen.
 */
const generateDefaultPoNumber = (): string => `PO-DRAFT-${Date.now().toString(36).toUpperCase()}`;

/**
 * Every plain `db.select`/`db.transaction` call in this file (as opposed to a `TenantScopedRepository`
 * subclass's own `runScoped`) must set `app.current_org_id` itself — `supplier_products`/
 * `organizations` RLS policies read it via `current_setting('app.current_org_id')::uuid`, and an
 * unset session var casts the empty string to uuid, which Postgres rejects outright (confirmed live:
 * `invalid input syntax for type uuid: ""`, root-caused by bisecting each query in this function
 * with a caught-error test before this fix). This is the same "plain queries need their own tenant
 * context" class this codebase has hit repeatedly — `findReorderSuggestions` itself already gets
 * this right by wrapping its whole query in `withTenantContext`; this function's own bare selects
 * did not, until this fix.
 */
const withScopedTx = async <T>(db: Db, organizationId: string, fn: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>): Promise<T> =>
  db.transaction((tx) => withTenantContext(tx, organizationId, () => fn(tx)));

/**
 * Approving a draft is deliberately NOT one database transaction spanning `create` + every
 * `addLine` — both repository methods open their OWN transaction internally via `runScoped`
 * (confirmed by reading them; composing from outside would silently run as N+1 separate
 * transactions regardless, the exact anti-pattern this codebase's own established lesson warns
 * against for methods shaped this way). A `DRAFT` PO existing briefly with fewer lines than
 * intended is not a new invariant violation — `create` alone already produces a real, reachable
 * `DRAFT` PO with zero lines in this codebase today, and a `DRAFT` PO is never itself a source of
 * truth for stock/cost (only `SENT`/received state feeds the costing chain) — so a partial-line
 * failure here is recoverable (the PO stays in DRAFT, a human or a retry can add the missing
 * lines), never silently wrong money.
 */
export const applyApprovedReorderDraft = async (
 db: Db,
 organizationId: string,
 storeId: string,
 createdByUserId: string,
 draft: { lines: DraftActionLine[] },
 poNumber?: string): Promise<ApproveReorderDraftResult> => {
 if (draft.lines.length === 0) {
 return { ok: false, reason: 'This draft has no lines to approve.' };
 }

 const sourced = await sourceReorderCandidates(db, organizationId, storeId);

 const resolvedLines: { row: NonNullable<ReturnType<typeof sourced.bySupplierProductId.get>>; quantity: Decimal }[] = [];
 const rejections: ApprovalRejection[] = [];

 for (const line of draft.lines) {
 const resolved = sourced.bySupplierProductId.get(line.candidateId);
 if (resolved === undefined) {
 rejections.push({ candidateId: line.candidateId, reason: 'This item no longer has a real, current reorder suggestion — it may have been ordered, restocked, or unmapped since this draft was created.' });
 continue;
 }
 // A PO line needs a real price to write a non-fabricated `lineTotal` (I5/I7) — `suggestReorder`
 // itself tolerates `unitPrice: null` (it only affects MOQ enforcement), but WRITING a real line
 // with no price would either fabricate 0 (silently free stock) or block on a value this
 // function has no honest way to invent. Reject explicitly instead.
 if (resolved.suggestion.unitPrice === null) {
 rejections.push({ candidateId: line.candidateId, reason: 'No confirmed supplier price exists yet for this item — cannot draft a real order line without one.' });
 continue;
 }
 resolvedLines.push({ row: resolved, quantity: line.quantity });
 }

 if (resolvedLines.length === 0) {
 return { ok: false, reason: 'None of this draft\'s lines could be re-verified against current data.' };
 }

 // Every resolved line's supplier must agree — `PurchaseOrderRepository` (matching this
 // codebase's existing "one PO per supplier" convention, see `findReorderSuggestions`'s own
 // supplier-grouped return shape) creates exactly one PO here. A draft mixing suppliers is a real
 // rejection of the mismatched lines, never a silently-wrong multi-supplier PO.
 const primarySupplierId = resolvedLines[0]!.row.supplierId;
 const sameSupplierLines = resolvedLines.filter((l) => l.row.supplierId === primarySupplierId);
 for (const l of resolvedLines) {
 if (l.row.supplierId !== primarySupplierId) {
 rejections.push({ candidateId: l.row.suggestion.supplierProductId, reason: `Different supplier (${l.row.supplierName}) than this PO's primary supplier — draft one PO per supplier.` });
 }
 }

 const [orgRow] = await withScopedTx(db, organizationId, (tx) =>
 tx.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, organizationId)));
 const currency = orgRow?.baseCurrency ?? 'USD';

 // One batched, tenant-scoped lookup for every line's supplier_product row — real
 // conversionToBase/packUnitId come from here, never the draft or the model (I6).
 const supplierProductIds = sameSupplierLines.map((l) => l.row.suggestion.supplierProductId);
 const spRows =
 supplierProductIds.length > 0
 ? await withScopedTx(db, organizationId, (tx) =>
 tx.select({ id: supplierProducts.id, conversionToBase: supplierProducts.conversionToBase, packUnitId: supplierProducts.packUnitId }).from(supplierProducts).where(inArray(supplierProducts.id, supplierProductIds)))
 : [];
 const spById = new Map(spRows.map((r) => [r.id, r]));

 const poRepo = new PurchaseOrderRepository(db, organizationId);
 const created = await poRepo.create({
 storeId,
 supplierId: primarySupplierId,
 poNumber: poNumber ?? generateDefaultPoNumber(),
 currency,
 createdByUserId,
 });

 let lineNumber = 1;
 for (const l of sameSupplierLines) {
 const spRow = spById.get(l.row.suggestion.supplierProductId);

 const addResult = await poRepo.addLine({
 purchaseOrderId: created.id,
 supplierProductId: l.row.suggestion.supplierProductId,
 productId: l.row.suggestion.productId,
 variantId: l.row.suggestion.variantId,
 quantityOrderUnits: l.quantity.toString(), ...(spRow?.packUnitId !== null && spRow?.packUnitId !== undefined ? { orderUnitId: spRow.packUnitId } : {}),
 conversionToBase: spRow?.conversionToBase ?? '1',
 // Real, already-verified-non-null above — the SAME price findReorderSuggestions itself
 // looked up (I2), never a second query or a fabricated value.
 unitPrice: l.row.suggestion.unitPrice as string,
 lineNumber: lineNumber++,
 });

 if (!addResult.ok) {
 rejections.push({ candidateId: l.row.suggestion.supplierProductId, reason: `Could not add this line to the new PO: ${addResult.reason}.` });
 }
 }

 return { ok: true, purchaseOrderId: created.id, rejections };
};
