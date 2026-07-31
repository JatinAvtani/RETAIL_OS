import { ALL_PERMISSIONS, type Permission } from './permission';
import type { Role } from './role';

/**
 * Derived from each persona's `**Permissions:**` prose in spec 04 §4.2–4.5 (the precise source),
 * cross-checked against the §4.8 feature matrix for consistency. The matrix has some capability
 * rows (e.g. "View dashboard & briefing") that don't correspond to any single Permission value in
 * spec 14 §14.3's coarser union — those are UI/routing concerns, not permission-gated resources,
 * and are deliberately not represented here.
 *
 * PO approval **above** a Manager's configured threshold is NOT modeled as a missing permission —
 * Manager genuinely has `purchasing:approve`; the threshold itself is `membership.approvalLimit`
 * (a Money value), checked separately at the point of approval, not a permission grant/deny.
 * Conflating the two would make "approve up to $500" inexpressible as a boolean permission.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  OWNER: ALL_PERMISSIONS,
  MANAGER: [
    'inventory:read',
    'inventory:write',
    'inventory:adjust',
    'purchasing:read',
    'purchasing:write',
    'purchasing:approve',
    'financial:read',
    'documents:read',
    'documents:approve',
  ],
  STAFF: ['inventory:read', 'inventory:write', 'inventory:adjust'],
  VIEWER_FINANCE: ['financial:read', 'financial:export', 'documents:read'],
};

export const permissionsForRole = (role: Role): ReadonlySet<Permission> =>
  new Set(ROLE_PERMISSIONS[role]);
