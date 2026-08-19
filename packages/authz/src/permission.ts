/**
 * Exactly the union from the design — do not add a permission without updating that section,
 * since this is the ground truth for "what can be gated at all" across the whole app.
 */
export type Permission =
  | 'inventory:read'
  | 'inventory:write'
  | 'inventory:adjust'
  | 'purchasing:read'
  | 'purchasing:write'
  | 'purchasing:approve'
  | 'financial:read'
  | 'financial:export'
  | 'documents:read'
  | 'documents:approve'
  | 'users:manage'
  | 'settings:manage'
  | 'billing:manage';

export const ALL_PERMISSIONS: readonly Permission[] = [
  'inventory:read',
  'inventory:write',
  'inventory:adjust',
  'purchasing:read',
  'purchasing:write',
  'purchasing:approve',
  'financial:read',
  'financial:export',
  'documents:read',
  'documents:approve',
  'users:manage',
  'settings:manage',
  'billing:manage',
];
