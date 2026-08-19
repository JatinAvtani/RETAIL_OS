import type { Money } from '@retailos/domain';
import type { Permission } from './permission';
import type { Role } from './role';

/**
 * Matches the design exactly. Built once per request from the session record (packages/session)
 * plus the membership row it resolves to — this package doesn't build one itself, since doing so
 * would require importing packages/db/packages/session and create a dependency this pure
 * permission-model package shouldn't have.
 */
export type AuthContext = {
  userId: string;
  organizationId: string;
  storeIds: string[] | 'ALL';
  role: Role;
  permissions: ReadonlySet<Permission>;
  approvalLimit?: Money;
};

/** Enforcement rule 1: every check is explicit — no permission means denied. */
export const hasPermission = (ctx: AuthContext, permission: Permission): boolean =>
  ctx.permissions.has(permission);

export const hasAnyPermission = (ctx: AuthContext, permissions: readonly Permission[]): boolean =>
  permissions.some((p) => ctx.permissions.has(p));

export const hasAllPermissions = (ctx: AuthContext, permissions: readonly Permission[]): boolean =>
  permissions.every((p) => ctx.permissions.has(p));

/**
 * Enforcement rule 2: object-level store scoping is a SEPARATE check from having
 * the permission at all — a Manager of Store A has `inventory:write`, but must still fail this
 * check for Store B's resources. `storeIds: 'ALL'` means org-wide access (Owner, or a Manager with
 * no store restriction); an array means the caller is scoped to exactly those stores.
 *
 * Takes just the one field it needs, not a full `AuthContext` — callers with only a raw session
 * record (e.g. `apps/api`'s `protectedProcedure`, which doesn't build a full `AuthContext` since
 * nothing needed the other fields until this check) can call this without fabricating one.
 */
export const canAccessStore = (ctx: Pick<AuthContext, 'storeIds'>, storeId: string): boolean =>
  ctx.storeIds === 'ALL' || ctx.storeIds.includes(storeId);

/**
 * PO approval threshold check. A
 * missing `approvalLimit` means unrestricted (Owner, or a Manager with no configured cap) — NOT
 * zero, which would incorrectly mean "cannot approve anything" (see the same reasoning on the
 * `approvalLimit` column itself in packages/db/src/schema/memberships.ts).
 */
export const canApproveAmount = (ctx: AuthContext, amount: Money): boolean => {
  if (!hasPermission(ctx, 'purchasing:approve')) {
    return false;
  }
  if (!ctx.approvalLimit) {
    return true;
  }
  if (amount.currency !== ctx.approvalLimit.currency) {
    throw new Error(
      `Currency mismatch checking approval limit: amount is ${amount.currency}, limit is ${ctx.approvalLimit.currency}`
    );
  }
  return amount.amount.lessThanOrEqualTo(ctx.approvalLimit.amount);
};
