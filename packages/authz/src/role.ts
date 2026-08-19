/**
 * Matches membership_role in packages/db/src/schema/memberships.ts exactly — kept as a separate
 * literal union here (not imported from packages/db) so this package has zero dependency on
 * Postgres/Drizzle; the two are kept in sync by convention (both derive from the design), and a
 * mismatch would surface immediately as a type error wherever a DB role value is assigned to this
 * type.
 */
export type Role = 'OWNER' | 'MANAGER' | 'STAFF' | 'VIEWER_FINANCE';
