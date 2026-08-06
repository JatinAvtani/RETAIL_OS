/**
 * Spec 14 §14.3: "Object storage paths are tenant-prefixed." Every key this function builds starts
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

/** 007-03: a quarantined email attachment's storage key — a real organizationId when the recipient resolved to one, or `'unresolved'` when it didn't (there is no tenant prefix to give it). */
export const buildEmailQuarantineAttachmentKey = (organizationId: string | null, intakeId: string, extension: string): string =>
  `org/${organizationId ?? 'unresolved'}/email-quarantine/${intakeId}.${extension}`;
