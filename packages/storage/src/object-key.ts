/**
 * Spec 14 §14.3: "Object storage paths are tenant-prefixed." Every key this function builds starts
 * with the owning organization's id, so a leaked/misused key from one tenant is structurally
 * distinguishable from another's — the same defense-in-depth reasoning as `TenantScopedRepository`
 * ANDing `organization_id` into every query even though RLS already enforces it.
 */
export const buildProductImageKey = (organizationId: string, productId: string, extension: string): string =>
  `org/${organizationId}/products/${productId}/image.${extension}`;
