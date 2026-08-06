import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { documentEmailIntake, documentEmailIntakeAttachments, organizations, type documentEmailIntakeStatusEnum } from '../schema/index';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type DocumentEmailIntakeStatus = (typeof documentEmailIntakeStatusEnum.enumValues)[number];

/**
 * 007-03: `document_email_intake`/`document_email_intake_attachments` deliberately do NOT get RLS
 * (see the schema file's own comment — `organization_id` is nullable, a real and expected state for
 * a recipient address that doesn't resolve to any tenant at all), so this is a plain repository, not
 * a `TenantScopedRepository` subclass — there is no single organizationId to construct one with
 * before the recipient address has even been parsed. Every method here builds its own explicit
 * predicate by hand where a real organizationId is known, matching this project's own standing rule
 * that a plain query against a table outside `TenantScopedRepository` still needs deliberate scoping
 * — the difference here is the scoping is sometimes genuinely absent, not merely unenforced by RLS.
 */
export class DocumentEmailIntakeRepository {
  constructor(private readonly db: Db) {}

  /** Case-insensitive: the recipient slug is already lowercased by `extractOrganizationSlugFromRecipient`, but a stored slug's exact casing shouldn't matter for this lookup either. */
  async findOrganizationBySlug(slug: string): Promise<{ id: string } | null> {
    const rows = await this.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
    return rows[0] ?? null;
  }

  async record(input: {
    organizationId: string | null;
    status: DocumentEmailIntakeStatus;
    recipientAddress: string;
    senderEmail: string;
    senderName?: string;
    subject?: string;
    attachmentCount: number;
    rawPayload: unknown;
  }): Promise<{ id: string }> {
    const id = generateId();
    await this.db.insert(documentEmailIntake).values({
      id,
      organizationId: input.organizationId,
      status: input.status,
      recipientAddress: input.recipientAddress,
      senderEmail: input.senderEmail,
      senderName: input.senderName ?? null,
      subject: input.subject ?? null,
      attachmentCount: input.attachmentCount,
      rawPayload: input.rawPayload,
    });
    return { id };
  }

  async recordAttachment(input: { intakeId: string; fileName: string; mimeType: string; sizeBytes: number; storageKey: string }): Promise<{ id: string }> {
    const id = generateId();
    await this.db.insert(documentEmailIntakeAttachments).values({
      id,
      intakeId: input.intakeId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      storageKey: input.storageKey,
    });
    return { id };
  }

  /** The operator-visible quarantine queue for one org — an explicit `organizationId` predicate, not RLS, since this table has none. */
  async listQuarantinedForOrganization(organizationId: string) {
    return this.db
      .select()
      .from(documentEmailIntake)
      .where(and(eq(documentEmailIntake.organizationId, organizationId), eq(documentEmailIntake.status, 'QUARANTINED_UNKNOWN_SENDER')))
      .orderBy(desc(documentEmailIntake.createdAt));
  }
}
