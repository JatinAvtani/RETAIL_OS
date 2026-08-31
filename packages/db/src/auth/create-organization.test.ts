import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { organizations, stores } from '../schema/index';
import { createOrganizationWithOwner } from './create-organization.js';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('createOrganizationWithOwner', () => {
  let appClient: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  let adminDb: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(() => {
    appClient = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    appDb = drizzle(appClient, { schema });
    adminDb = drizzle(adminClient, { schema });
  });

  afterAll(async () => {
    await appClient.end();
    await adminClient.end();
  });

  it('rolls back the organization and store when owner membership creation fails', async () => {
    const organizationName = `Atomic signup rollback ${generateId()}`;
    const storeName = `Rollback store ${generateId()}`;
    const missingUserId = generateId();

    let failure: unknown;
    try {
      await createOrganizationWithOwner(appDb, {
        organizationName,
        storeName,
        storeTimezone: 'Asia/Kolkata',
        baseCurrency: 'INR',
        userId: missingUserId,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: '23503',
      constraint_name: 'memberships_user_id_users_id_fk',
    });

    const organizationRows = await adminDb
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.name, organizationName));
    expect(organizationRows).toEqual([]);

    const storeRows = await adminDb
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.name, storeName));
    expect(storeRows).toEqual([]);
  });
});
