/**
 * the design: "Object storage paths are tenant-prefixed." Every key this function builds starts
 * with the owning organization's id, so a leaked/misused key from one tenant is structurally
 * distinguishable from another's — the same defense-in-depth reasoning as `TenantScopedRepository`
 * ANDing `organization_id` into every query even though RLS already enforces it.
 */
export const buildProductImageKey = (organizationId: string, productId: string, extension: string): string =>
  `org/${organizationId}/products/${productId}/image.${extension}`;

export const buildCsvImportKey = (organizationId: string, importId: string): string =>
  `org/${organizationId}/sales-csv-imports/${importId}.csv`;

/** `extension` is derived server-side from the verified magic bytes (see `detectDocumentFormat`), never from a client-supplied filename. */
export const buildDocumentKey = (organizationId: string, documentId: string, extension: string): string =>
  `org/${organizationId}/documents/${documentId}.${extension}`;

/** earlier work: a quarantined email attachment's storage key — a real organizationId when the recipient resolved to one, or `'unresolved'` when it didn't (there is no tenant prefix to give it). */
export const buildEmailQuarantineAttachmentKey = (organizationId: string | null, intakeId: string, extension: string): string =>
  `org/${organizationId ?? 'unresolved'}/email-quarantine/${intakeId}.${extension}`;

/** earlier work: the generated PO PDF's storage key — one PDF per PO, overwritten if regenerated (a PO is only ever SENT once per version, but re-sending an amendment reuses the same key deliberately, matching `buildProductImageKey`'s own "latest wins" convention). */
export const buildPurchaseOrderPdfKey = (organizationId: string, purchaseOrderId: string): string =>
  `org/${organizationId}/purchase-orders/${purchaseOrderId}.pdf`;

/** earlier work: a damage-claim photo for one goods-receipt line — `photoId` is a fresh id per upload (never reused, unlike `buildProductImageKey`'s "latest wins"), since a receipt line can carry MULTIPLE photos appended one at a time, none of which should overwrite an earlier one. */
export const buildGoodsReceiptLinePhotoKey = (organizationId: string, goodsReceiptLineId: string, photoId: string, extension: string): string =>
  `org/${organizationId}/goods-receipt-lines/${goodsReceiptLineId}/photos/${photoId}.${extension}`;
