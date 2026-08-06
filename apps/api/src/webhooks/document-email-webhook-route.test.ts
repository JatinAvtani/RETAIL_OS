import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, documentEmailIntake, documentEmailIntakeAttachments, documents, organizations, stores, suppliers } from '@retailos/db';
import { generateId } from '@retailos/domain';
import { buildServer } from '../server';
import type { FastifyInstance } from 'fastify';

// Same reasoning as documents.test.ts (007-04): a real GEMINI_API_KEY in .env.local would make the
// ACCEPTED-sender path's classification call real, slow, and rate-limited against meaningless fake
// PDF bytes — forced off for deterministic test behavior.
delete process.env.GEMINI_API_KEY;

const USERNAME = 'test-postmark-user';
const PASSWORD = 'test-postmark-pass';
const basicAuthHeader = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;

const REAL_PDF_BASE64 = Buffer.from('%PDF-1.4\n%%EOF').toString('base64');

const buildPayload = (overrides: Partial<{ recipientEmail: string; senderEmail: string; senderName: string; attachments: unknown[] }> = {}) => ({
  FromFull: { Email: overrides.senderEmail ?? 'billing@realsupplier.example', Name: overrides.senderName ?? 'Real Supplier', MailboxHash: '' },
  ToFull: [{ Email: overrides.recipientEmail ?? 'invoices@replace-me.retailos.app', Name: '', MailboxHash: '' }],
  Subject: 'Invoice #1',
  Attachments: overrides.attachments ?? [{ Name: 'invoice.pdf', Content: REAL_PDF_BASE64, ContentType: 'application/pdf', ContentLength: 15 }],
});

/**
 * 007-03: real HTTP verification for the inbound-email webhook. No real Postmark account exists
 * (confirmed with the user) — payloads are shaped exactly like Postmark's real documented format
 * (`packages/email`'s own tests prove the parser against that shape independently); this suite
 * proves the ROUTE's own auth/org-resolution/allowlist/quarantine logic, the actual risk surface.
 */
describe('POST /webhooks/inbound-email', () => {
  let app: FastifyInstance;
  let originalEnv: Record<string, string | undefined>;
  const { db } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos');
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    originalEnv = {
      POSTMARK_WEBHOOK_USERNAME: process.env.POSTMARK_WEBHOOK_USERNAME,
      POSTMARK_WEBHOOK_PASSWORD: process.env.POSTMARK_WEBHOOK_PASSWORD,
    };
    process.env.POSTMARK_WEBHOOK_USERNAME = USERNAME;
    process.env.POSTMARK_WEBHOOK_PASSWORD = PASSWORD;
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      const intakeRows = await db.select({ id: documentEmailIntake.id }).from(documentEmailIntake).where(eq(documentEmailIntake.organizationId, orgId));
      for (const row of intakeRows) {
        await db.delete(documentEmailIntakeAttachments).where(eq(documentEmailIntakeAttachments.intakeId, row.id));
      }
      await db.delete(documentEmailIntake).where(eq(documentEmailIntake.organizationId, orgId));
      await db.delete(documents).where(eq(documents.organizationId, orgId));
      await db.delete(suppliers).where(eq(suppliers.organizationId, orgId));
      await db.delete(stores).where(eq(stores.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  afterAll(async () => {
    process.env.POSTMARK_WEBHOOK_USERNAME = originalEnv.POSTMARK_WEBHOOK_USERNAME;
    process.env.POSTMARK_WEBHOOK_PASSWORD = originalEnv.POSTMARK_WEBHOOK_PASSWORD;
    await app.close();
  });

  const setUpOrgWithSupplier = async (supplierContactEmail: string | null): Promise<{ organizationId: string; slug: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    const slug = `email-webhook-test-${organizationId}`;
    await db.insert(organizations).values({ id: organizationId, name: 'Email Webhook Test Org', slug, baseCurrency: 'USD' });
    await db.insert(stores).values({ id: generateId(), organizationId, name: 'Main Store', timezone: 'America/New_York' });
    if (supplierContactEmail) {
      await db.insert(suppliers).values({
        id: generateId(),
        organizationId,
        name: 'Real Supplier Co',
        contacts: [{ name: 'Billing', email: supplierContactEmail, phone: null, role: 'billing' }],
      });
    }
    return { organizationId, slug };
  };

  it('rejects a request with no Authorization header', async () => {
    const response = await app.inject({ method: 'POST', url: '/webhooks/inbound-email', payload: buildPayload() });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a request with wrong Basic Auth credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/inbound-email',
      headers: { authorization: `Basic ${Buffer.from('wrong:creds').toString('base64')}` },
      payload: buildPayload(),
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts a genuinely malformed payload from an authenticated request with 200, never posting anything', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/inbound-email',
      headers: { authorization: basicAuthHeader, 'content-type': 'application/json' },
      payload: '{"not": "a valid postmark payload"}',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ received: true, parsed: false });
  });

  it('records REJECTED_UNKNOWN_ORGANIZATION and returns 200 for a recipient slug that does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/inbound-email',
      headers: { authorization: basicAuthHeader },
      payload: buildPayload({ recipientEmail: 'invoices@no-such-organization-at-all.retailos.app' }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ received: true, resolved: false });

    const rows = await db.select().from(documentEmailIntake).where(eq(documentEmailIntake.recipientAddress, 'invoices@no-such-organization-at-all.retailos.app'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('REJECTED_UNKNOWN_ORGANIZATION');
    expect(rows[0]?.organizationId).toBeNull();
    await db.delete(documentEmailIntake).where(eq(documentEmailIntake.id, rows[0]!.id));
  });

  it('quarantines an email from a sender NOT in the org\'s supplier contacts', async () => {
    const { organizationId, slug } = await setUpOrgWithSupplier('known@realsupplier.example');

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/inbound-email',
      headers: { authorization: basicAuthHeader },
      payload: buildPayload({ recipientEmail: `invoices@${slug}.retailos.app`, senderEmail: 'unknown-stranger@example.com' }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ received: true, quarantined: true });

    const intakeRows = await db.select().from(documentEmailIntake).where(eq(documentEmailIntake.organizationId, organizationId));
    expect(intakeRows).toHaveLength(1);
    expect(intakeRows[0]?.status).toBe('QUARANTINED_UNKNOWN_SENDER');

    const documentRows = await db.select().from(documents).where(eq(documents.organizationId, organizationId));
    expect(documentRows).toHaveLength(0);

    const attachmentRows = await db.select().from(documentEmailIntakeAttachments).where(eq(documentEmailIntakeAttachments.intakeId, intakeRows[0]!.id));
    expect(attachmentRows).toHaveLength(1);
  });

  it('accepts an email from a sender IN the org\'s supplier contacts and creates a real documents row', async () => {
    const { organizationId, slug } = await setUpOrgWithSupplier('billing@realsupplier.example');

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/inbound-email',
      headers: { authorization: basicAuthHeader },
      payload: buildPayload({ recipientEmail: `invoices@${slug}.retailos.app`, senderEmail: 'billing@realsupplier.example' }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ received: true, quarantined: false });

    const intakeRows = await db.select().from(documentEmailIntake).where(eq(documentEmailIntake.organizationId, organizationId));
    expect(intakeRows).toHaveLength(1);
    expect(intakeRows[0]?.status).toBe('ACCEPTED');

    const documentRows = await db.select().from(documents).where(eq(documents.organizationId, organizationId));
    expect(documentRows).toHaveLength(1);
    expect(documentRows[0]?.source).toBe('EMAIL');
    expect(documentRows[0]?.type).toBe('OTHER'); // GEMINI_API_KEY forced off above — classification not attempted
  });

  it('is case-insensitive when matching the sender against supplier contacts', async () => {
    const { organizationId, slug } = await setUpOrgWithSupplier('Billing@RealSupplier.example');

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/inbound-email',
      headers: { authorization: basicAuthHeader },
      payload: buildPayload({ recipientEmail: `invoices@${slug}.retailos.app`, senderEmail: 'billing@realsupplier.example' }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ received: true, quarantined: false });

    const documentRows = await db.select().from(documents).where(eq(documents.organizationId, organizationId));
    expect(documentRows).toHaveLength(1);
  });

  it('skips an accepted-sender attachment that is not a real PDF/JPEG/PNG, never posting a fabricated document', async () => {
    const { organizationId, slug } = await setUpOrgWithSupplier('billing@realsupplier.example');

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/inbound-email',
      headers: { authorization: basicAuthHeader },
      payload: buildPayload({
        recipientEmail: `invoices@${slug}.retailos.app`,
        senderEmail: 'billing@realsupplier.example',
        attachments: [{ Name: 'not-a-real-file.pdf', Content: Buffer.from('this is not a pdf').toString('base64'), ContentType: 'application/pdf', ContentLength: 18 }],
      }),
    });

    expect(response.statusCode).toBe(200);
    const documentRows = await db.select().from(documents).where(eq(documents.organizationId, organizationId));
    expect(documentRows).toHaveLength(0);
  });

  it('returns 503 when Postmark credentials are not configured on this server', async () => {
    const savedUsername = process.env.POSTMARK_WEBHOOK_USERNAME;
    delete process.env.POSTMARK_WEBHOOK_USERNAME;
    try {
      const response = await app.inject({ method: 'POST', url: '/webhooks/inbound-email', headers: { authorization: basicAuthHeader }, payload: buildPayload() });
      expect(response.statusCode).toBe(503);
    } finally {
      process.env.POSTMARK_WEBHOOK_USERNAME = savedUsername;
    }
  });
});
