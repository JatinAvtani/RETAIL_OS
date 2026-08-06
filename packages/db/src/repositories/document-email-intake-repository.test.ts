import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { documentEmailIntake, documentEmailIntakeAttachments, organizations, stores } from '../schema/index';
import { DocumentEmailIntakeRepository } from './document-email-intake-repository';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('DocumentEmailIntakeRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let organizationId: string;
  let orgSlug: string;
  let repository: DocumentEmailIntakeRepository;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    db = drizzle(client, { schema });
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    orgSlug = `email-intake-test-${organizationId}`;
    await adminDb.insert(organizations).values({ id: organizationId, name: 'Email Intake Test Org', slug: orgSlug, baseCurrency: 'USD' });
    await adminDb.insert(stores).values({ id: generateId(), organizationId, name: 'Main Store', timezone: 'America/New_York' });

    repository = new DocumentEmailIntakeRepository(db);
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    const intakeRows = await adminDb.select({ id: documentEmailIntake.id }).from(documentEmailIntake).where(eq(documentEmailIntake.organizationId, organizationId));
    for (const row of intakeRows) {
      await adminDb.delete(documentEmailIntakeAttachments).where(eq(documentEmailIntakeAttachments.intakeId, row.id));
    }
    await adminDb.delete(documentEmailIntake).where(eq(documentEmailIntake.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('findOrganizationBySlug finds a real organization by its slug', async () => {
    const found = await repository.findOrganizationBySlug(orgSlug);
    expect(found?.id).toBe(organizationId);
  });

  it('findOrganizationBySlug returns null for an unknown slug', async () => {
    const found = await repository.findOrganizationBySlug('no-such-org-slug-at-all');
    expect(found).toBeNull();
  });

  it('records an ACCEPTED intake row with a real organizationId', async () => {
    const { id } = await repository.record({
      organizationId,
      status: 'ACCEPTED',
      recipientAddress: `invoices@${orgSlug}.retailos.app`,
      senderEmail: 'billing@realsupplier.example',
      senderName: 'Real Supplier',
      subject: 'Invoice #123',
      attachmentCount: 1,
      rawPayload: { test: true },
    });
    expect(id).toBeTruthy();
  });

  it('records a REJECTED_UNKNOWN_ORGANIZATION row with a null organizationId', async () => {
    const { id } = await repository.record({
      organizationId: null,
      status: 'REJECTED_UNKNOWN_ORGANIZATION',
      recipientAddress: 'invoices@no-such-slug.retailos.app',
      senderEmail: 'attacker@example.com',
      attachmentCount: 0,
      rawPayload: { test: true },
    });
    expect(id).toBeTruthy();
  });

  it('recordAttachment links an attachment to its intake row', async () => {
    const { id: intakeId } = await repository.record({
      organizationId,
      status: 'QUARANTINED_UNKNOWN_SENDER',
      recipientAddress: `invoices@${orgSlug}.retailos.app`,
      senderEmail: 'unknown@example.com',
      attachmentCount: 1,
      rawPayload: { test: true },
    });
    const { id: attachmentId } = await repository.recordAttachment({
      intakeId,
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1234,
      storageKey: `org/${organizationId}/email-quarantine/${intakeId}/invoice.pdf`,
    });
    expect(attachmentId).toBeTruthy();
  });

  it('listQuarantinedForOrganization returns only QUARANTINED_UNKNOWN_SENDER rows for the given org', async () => {
    await repository.record({
      organizationId,
      status: 'QUARANTINED_UNKNOWN_SENDER',
      recipientAddress: `invoices@${orgSlug}.retailos.app`,
      senderEmail: 'unknown-1@example.com',
      attachmentCount: 0,
      rawPayload: {},
    });
    await repository.record({
      organizationId,
      status: 'ACCEPTED',
      recipientAddress: `invoices@${orgSlug}.retailos.app`,
      senderEmail: 'trusted@example.com',
      attachmentCount: 1,
      rawPayload: {},
    });

    const quarantined = await repository.listQuarantinedForOrganization(organizationId);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.senderEmail).toBe('unknown-1@example.com');
  });

  it('listQuarantinedForOrganization never returns another organization\'s rows (explicit predicate, no RLS on this table)', async () => {
    const otherOrgId = generateId();
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.insert(organizations).values({ id: otherOrgId, name: 'Other Org', slug: `other-org-${otherOrgId}`, baseCurrency: 'USD' });

    await repository.record({
      organizationId: otherOrgId,
      status: 'QUARANTINED_UNKNOWN_SENDER',
      recipientAddress: `invoices@other-org-${otherOrgId}.retailos.app`,
      senderEmail: 'unknown@example.com',
      attachmentCount: 0,
      rawPayload: {},
    });

    const quarantinedForOriginalOrg = await repository.listQuarantinedForOrganization(organizationId);
    expect(quarantinedForOriginalOrg.every((row) => row.organizationId === organizationId)).toBe(true);

    await adminDb.delete(documentEmailIntake).where(eq(documentEmailIntake.organizationId, otherOrgId));
    await adminDb.delete(organizations).where(eq(organizations.id, otherOrgId));
  });
});
