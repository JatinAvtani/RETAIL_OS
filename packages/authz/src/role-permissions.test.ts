import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from './permission';
import { permissionsForRole, ROLE_PERMISSIONS } from './role-permissions';
import type { Role } from './role';

describe('ROLE_PERMISSIONS', () => {
  it('OWNER has every permission', () => {
    expect(new Set(ROLE_PERMISSIONS.OWNER)).toEqual(new Set(ALL_PERMISSIONS));
  });

  it('MANAGER can operate inventory and purchasing but not manage users, settings, or billing', () => {
    const manager = permissionsForRole('MANAGER');
    expect(manager.has('inventory:write')).toBe(true);
    expect(manager.has('purchasing:approve')).toBe(true);
    expect(manager.has('financial:read')).toBe(true);
    expect(manager.has('users:manage')).toBe(false);
    expect(manager.has('settings:manage')).toBe(false);
    expect(manager.has('billing:manage')).toBe(false);
    expect(manager.has('financial:export')).toBe(false);
  });

  it('STAFF has only inventory operations, no financial visibility at all', () => {
    const staff = permissionsForRole('STAFF');
    expect(staff.has('inventory:read')).toBe(true);
    expect(staff.has('inventory:write')).toBe(true);
    expect(staff.has('inventory:adjust')).toBe(true);
    expect(staff.has('financial:read')).toBe(false);
    expect(staff.has('purchasing:read')).toBe(false);
    expect(staff.has('documents:read')).toBe(false);
  });

  it('VIEWER_FINANCE is read-only on financial data plus documents, no operational writes', () => {
    const viewerFinance = permissionsForRole('VIEWER_FINANCE');
    expect(viewerFinance.has('financial:read')).toBe(true);
    expect(viewerFinance.has('financial:export')).toBe(true);
    expect(viewerFinance.has('documents:read')).toBe(true);
    expect(viewerFinance.has('inventory:write')).toBe(false);
    expect(viewerFinance.has('purchasing:write')).toBe(false);
    expect(viewerFinance.has('documents:approve')).toBe(false);
  });

  it('every role is represented and every permission set is non-empty', () => {
    const roles: Role[] = ['OWNER', 'MANAGER', 'STAFF', 'VIEWER_FINANCE'];
    for (const role of roles) {
      expect(ROLE_PERMISSIONS[role].length).toBeGreaterThan(0);
    }
  });

  it('no role is granted a permission outside the known Permission union (typo/drift guard)', () => {
    const allPermissionsSet = new Set(ALL_PERMISSIONS);
    for (const role of Object.keys(ROLE_PERMISSIONS) as Role[]) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(allPermissionsSet.has(permission)).toBe(true);
      }
    }
  });
});
