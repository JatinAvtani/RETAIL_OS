import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId, type CurrencyCode } from '@retailos/domain';
import * as schema from '../schema/index';
import { organizations, stores, memberships } from '../schema/index';
import { withTenantContext } from '../tenant-context';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * The real, previously-missing "first user creates their workspace" step (found while building the
 * signup UI: `auth.signup` only ever created a `users` row — no procedure anywhere created an
 * organization, so a brand-new signup had no path to a usable account beyond `seed-demo.mts`, a raw
 * offline script). Confirmed with the user via `AskUserQuestion`: build this for real rather than
 * requiring every first user to be invited by someone who doesn't yet exist.
 *
 * A plain module-level function, not a method on `OrganizationRepository` — that class requires an
 * existing `organizationId` at construction (see its own doc comment), and there is no
 * organizationId to provide yet when creating the org itself. Matches
 * `InvitationRepository`'s own established precedent for this exact "pre-tenant" shape.
 *
 * Creates the organization (no RLS — it IS the tenant boundary, not a tenant-scoped row), then the
 * store and an already-ACCEPTED OWNER membership inside ONE `withTenantContext`-wrapped transaction
 * (stores/memberships are both FORCE RLS) — a signup that produced an org with no store or no owner
 * would be a genuinely broken account, so all three commit together or not at all. The membership's
 * `acceptedAt` is set immediately (never a pending invite to themselves) — matching how OWNER, the
 * founding member, has always been seeded in `seed-demo.mts`.
 *
 * `baseCurrency` is a real, one-time choice made at signup, never changeable afterward — no
 * conversion logic exists anywhere in this codebase (confirmed before building this), so a
 * currency change after real financial data exists would silently mix untagged amounts across an
 * org's own history. Offering the choice ONCE, before any data exists, is what makes it safe;
 * `organizations.baseCurrency` remains the single source every metric reads from — see
 * `resolveCurrency()` in `packages/metrics/src/catalog/currency.ts`.
 */
export const createOrganizationWithOwner = async (
  db: Db,
  input: { organizationName: string; storeName: string; storeTimezone: string; baseCurrency: CurrencyCode; userId: string }
): Promise<{ organizationId: string; storeId: string; membershipId: string }> => {
  const organizationId = generateId();
  const slug = `${input.organizationName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')}-${organizationId}`;

  await db.insert(organizations).values({
    id: organizationId,
    name: input.organizationName,
    slug,
    baseCurrency: input.baseCurrency,
  });

  const storeId = generateId();
  const membershipId = generateId();

  await db.transaction((tx) =>
    withTenantContext(tx, organizationId, async () => {
      await tx.insert(stores).values({
        id: storeId,
        organizationId,
        name: input.storeName,
        timezone: input.storeTimezone,
      });

      await tx.insert(memberships).values({
        id: membershipId,
        organizationId,
        userId: input.userId,
        role: 'OWNER',
        storeIds: null, // NULL = org-wide access to all current and future stores (schema's own convention).
        acceptedAt: new Date(),
      });
    })
  );

  return { organizationId, storeId, membershipId };
};
