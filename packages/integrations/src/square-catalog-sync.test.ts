import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, organizations, posConnections, posItems, stores } from '@retailos/db';
import { encryptToken, type SquareOAuthConfig } from '@retailos/pos';
import { generateId } from '@retailos/domain';
import { syncSquareCatalog, SquareNotConnectedError } from './square-catalog-sync';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

const ENCRYPTION_KEY = 'test-encryption-key-for-integrations-package';

const squareConfig: SquareOAuthConfig = {
  applicationId: 'sq0idp-test-app-id',
  applicationSecret: 'sq0csp-test-secret',
  redirectUri: 'http://localhost:3001/integrations/square/callback',
  environment: 'sandbox',
};

/**
 * Real Postgres verification for `syncSquareCatalog`, called DIRECTLY (no router, no HTTP, no
 * session) — this moved out of `apps/api/src/trpc/routers/integrations.test.ts` when the function
 * itself relocated to this package so `apps/worker`'s job processor could call the identical code.
 * `global.fetch` is patched (Square's own host only) — no live Square sandbox app exists in this
 * codebase, same standing limitation the router test originally documented.
 *
 * Two real connections, matching every other real-DB test in this repo
 * (`packages/db/src/repositories/*.test.ts`): `appDb` (the `retailos_app` role, RLS-scoped —
 * the same connection shape `syncSquareCatalog` gets in production, since it calls
 * `PosConnectionRepository`/`PosItemRepository` which set `app.current_org_id` per transaction) is
 * what's passed into the function under test, while `adminDb` (the `postgres` superuser) seeds and
 * tears down fixtures across tenants — exactly the operation RLS exists to prevent for the app role.
 */
describe('syncSquareCatalog', () => {
  const { db: appDb, client: appClient } = createDb(APP_CONNECTION_STRING);
  const { db: adminDb, client: adminClient } = createDb(ADMIN_CONNECTION_STRING);
  const createdOrgIds: string[] = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const orgId of createdOrgIds) {
      await adminDb.delete(posItems).where(eq(posItems.organizationId, orgId));
      await adminDb.delete(posConnections).where(eq(posConnections.organizationId, orgId));
      await adminDb.delete(stores).where(eq(stores.organizationId, orgId));
      await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  afterAll(async () => {
    await appClient.end();
    await adminClient.end();
  });

  const setUpOrgWithStore = async (): Promise<{ organizationId: string; storeId: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: `Square Catalog Sync Test Org ${organizationId}`,
      slug: `square-catalog-sync-test-org-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });
    return { organizationId, storeId };
  };

  const connectSquare = async (organizationId: string, storeId: string): Promise<void> => {
    await adminDb.insert(posConnections).values({
      id: generateId(),
      organizationId,
      storeId,
      vendor: 'square',
      externalAccountId: 'test-merchant',
      accessTokenCiphertext: encryptToken('fake-access-token', ENCRYPTION_KEY),
      refreshTokenCiphertext: encryptToken('fake-refresh-token', ENCRYPTION_KEY),
      status: 'CONNECTED',
    });
  };

  const stubSquareCatalogResponse = (body: unknown): void => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v2/catalog/search-catalog-objects')) {
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input);
    }) as typeof fetch;
  };

  it('throws SquareNotConnectedError for a store with no Square connection', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await expect(syncSquareCatalog(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY)).rejects.toThrow(
      SquareNotConnectedError
    );
  });

  it('a genuinely connected store syncs a real catalog page into pos_items as UNMAPPED', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await connectSquare(organizationId, storeId);

    stubSquareCatalogResponse({
      objects: [
        {
          id: 'ITEM-SYNC-1',
          type: 'ITEM',
          is_deleted: false,
          item_data: {
            name: 'Cappuccino',
            variations: [
              {
                id: 'VAR-SYNC-1',
                type: 'ITEM_VARIATION',
                item_variation_data: {
                  name: 'Regular',
                  sku: 'CAPP-1',
                  pricing_type: 'FIXED_PRICING',
                  price_money: { amount: 450, currency: 'USD' },
                },
              },
            ],
          },
        },
      ],
    });

    const result = await syncSquareCatalog(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
    expect(result.variationsUpserted).toBe(1);
    expect(result.itemsDelisted).toBe(0);
    expect(result.itemsSeen).toBe(1);

    const rows = await adminDb.select().from(posItems).where(eq(posItems.organizationId, organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.externalId).toBe('VAR-SYNC-1');
    expect(rows[0]!.mappingStatus).toBe('UNMAPPED');
    expect(rows[0]!.price).toBe('4.5000');
  });

  it('an item present in a prior sync but absent from the next is marked delisted, not deleted', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await connectSquare(organizationId, storeId);

    stubSquareCatalogResponse({
      objects: [
        {
          id: 'ITEM-GONE',
          type: 'ITEM',
          is_deleted: false,
          item_data: {
            name: 'Soon Gone',
            variations: [
              {
                id: 'VAR-GONE',
                type: 'ITEM_VARIATION',
                item_variation_data: { name: 'Regular', pricing_type: 'FIXED_PRICING', price_money: { amount: 300, currency: 'USD' } },
              },
            ],
          },
        },
      ],
    });
    const first = await syncSquareCatalog(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
    expect(first.variationsUpserted).toBe(1);

    // Second sync's catalog no longer includes VAR-GONE at all.
    await new Promise((resolve) => setTimeout(resolve, 10));
    stubSquareCatalogResponse({ objects: [] });
    const second = await syncSquareCatalog(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
    expect(second.itemsDelisted).toBe(1);

    const rows = await adminDb.select().from(posItems).where(eq(posItems.organizationId, organizationId));
    expect(rows).toHaveLength(1); // marked, not deleted
    expect(rows[0]!.delistedAt).not.toBeNull();
  });

  it('re-running the sync with the same catalog is idempotent — no duplicate rows', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await connectSquare(organizationId, storeId);

    const catalogBody = {
      objects: [
        {
          id: 'ITEM-IDEMPOTENT',
          type: 'ITEM',
          is_deleted: false,
          item_data: {
            name: 'Muffin',
            variations: [
              {
                id: 'VAR-IDEMPOTENT',
                type: 'ITEM_VARIATION',
                item_variation_data: { name: 'Regular', pricing_type: 'FIXED_PRICING', price_money: { amount: 250, currency: 'USD' } },
              },
            ],
          },
        },
      ],
    };

    for (let i = 0; i < 2; i++) {
      stubSquareCatalogResponse(catalogBody);
      const result = await syncSquareCatalog(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
      expect(result.variationsUpserted).toBe(1);
    }

    const rows = await adminDb.select().from(posItems).where(eq(posItems.organizationId, organizationId));
    expect(rows).toHaveLength(1);
  });
});
