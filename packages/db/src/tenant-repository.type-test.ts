/**
 * Compile-time proof that TenantScopedRepository rejects tables with no organization_id column
 * (organizations, users — see schema comments for why). Included in `tsc --noEmit`; if the type
 * constraint regresses, this file fails to compile and CI catches it.
 */
import { organizations } from './schema/index';
import { TenantScopedRepository } from './tenant-repository';

// @ts-expect-error — `organizations` has no organizationId column; it IS the tenant, not a
// tenant-scoped row, so it cannot be used with TenantScopedRepository at all.
class OrgRepo extends TenantScopedRepository<typeof organizations> {}

export type _Sink = OrgRepo;
export {};
