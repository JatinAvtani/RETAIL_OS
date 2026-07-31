import type { Permission, Role } from '@retailos/authz';

/** The record stored in Redis under `session:<token>`. Matches spec 14 §14.2's session shape. */
export type SessionRecord = {
  userId: string;
  organizationId: string;
  storeIds: string[] | 'ALL';
  role: Role;
  permissions: Permission[];
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
  ip: string;
  userAgent: string;
};

/** ip/userAgent are supplied as separate arguments to SessionStore.create, not part of this input. */
export type NewSessionInput = Omit<
  SessionRecord,
  'createdAt' | 'lastSeenAt' | 'absoluteExpiresAt' | 'ip' | 'userAgent'
>;
