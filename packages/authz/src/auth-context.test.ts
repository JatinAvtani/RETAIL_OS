import { describe, expect, it } from 'vitest';
import { money } from '@retailos/domain';
import {
  canAccessStore,
  canApproveAmount,
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  type AuthContext,
} from './auth-context';
import { permissionsForRole } from './role-permissions';

const makeCtx = (overrides: Partial<AuthContext> = {}): AuthContext => ({
  userId: 'user-1',
  organizationId: 'org-1',
  storeIds: 'ALL',
  role: 'MANAGER',
  permissions: permissionsForRole('MANAGER'),
  ...overrides,
});

describe('hasPermission / hasAnyPermission / hasAllPermissions', () => {
  it('hasPermission is true for a granted permission, false for one not granted', () => {
    const ctx = makeCtx();
    expect(hasPermission(ctx, 'inventory:write')).toBe(true);
    expect(hasPermission(ctx, 'billing:manage')).toBe(false);
  });

  it('hasAnyPermission is true if at least one listed permission is granted', () => {
    const ctx = makeCtx();
    expect(hasAnyPermission(ctx, ['billing:manage', 'inventory:read'])).toBe(true);
    expect(hasAnyPermission(ctx, ['billing:manage', 'users:manage'])).toBe(false);
  });

  it('hasAllPermissions is true only if every listed permission is granted', () => {
    const ctx = makeCtx();
    expect(hasAllPermissions(ctx, ['inventory:read', 'inventory:write'])).toBe(true);
    expect(hasAllPermissions(ctx, ['inventory:read', 'billing:manage'])).toBe(false);
  });

  it('a context with an empty permission set denies everything (fail closed)', () => {
    const ctx = makeCtx({ permissions: new Set() });
    expect(hasPermission(ctx, 'inventory:read')).toBe(false);
    expect(hasAnyPermission(ctx, ['inventory:read', 'financial:read'])).toBe(false);
  });
});

describe('canAccessStore', () => {
  it('ALL grants access to any store id', () => {
    const ctx = makeCtx({ storeIds: 'ALL' });
    expect(canAccessStore(ctx, 'store-a')).toBe(true);
    expect(canAccessStore(ctx, 'store-b')).toBe(true);
  });

  it('a scoped array grants access only to listed stores', () => {
    const ctx = makeCtx({ storeIds: ['store-a'] });
    expect(canAccessStore(ctx, 'store-a')).toBe(true);
    expect(canAccessStore(ctx, 'store-b')).toBe(false);
  });

  it('an empty array denies every store (not "no restriction")', () => {
    const ctx = makeCtx({ storeIds: [] });
    expect(canAccessStore(ctx, 'store-a')).toBe(false);
  });
});

describe('canApproveAmount', () => {
  it('denies outright if the role lacks purchasing:approve, regardless of amount', () => {
    const ctx = makeCtx({ role: 'STAFF', permissions: permissionsForRole('STAFF') });
    expect(canApproveAmount(ctx, money(1, 'USD'))).toBe(false);
  });

  it('no approvalLimit means unrestricted (not zero)', () => {
    const ctx = makeCtx();
    expect(canApproveAmount(ctx, money(1_000_000, 'USD'))).toBe(true);
  });

  it('approves an amount at or under the limit', () => {
    const ctx = makeCtx({ approvalLimit: money(500, 'USD') });
    expect(canApproveAmount(ctx, money(500, 'USD'))).toBe(true);
    expect(canApproveAmount(ctx, money(499.99, 'USD'))).toBe(true);
  });

  it('denies an amount over the limit', () => {
    const ctx = makeCtx({ approvalLimit: money(500, 'USD') });
    expect(canApproveAmount(ctx, money(500.01, 'USD'))).toBe(false);
  });

  it('throws on a currency mismatch between the amount and the limit, rather than silently comparing', () => {
    const ctx = makeCtx({ approvalLimit: money(500, 'USD') });
    expect(() => canApproveAmount(ctx, money(500, 'EUR'))).toThrow(/Currency mismatch/);
  });
});
