import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { idColumn } from './columns';

/**
 * every inbound-email webhook delivery this server accepted a real,
 * authenticated request for, whether or not the sender was ultimately trusted. the design
 * "email ingestion (documents)": "sender allowlist per tenant with quarantine for unknown senders —
 * an open email endpoint is an attack surface and a spam vector." `status` records the outcome
 * without needing a join back to `documents` — a quarantined email never produces one at all.
 *
 * `organizationId` is nullable: the recipient address (`invoices@<slug>.retailos.app`) is how the
 * org is resolved, but a genuinely malformed/unrecognized slug means there is no organization to
 * scope this row to at all — logged for operator visibility (a misconfigured or attacking sender),
 * never silently dropped and never forced into a real tenant's data. This table therefore does NOT
 * use RLS's own `organization_id`-based policy the way every genuinely tenant-owned table does; a
 * row with a null organizationId is a legitimate, expected state here, unlike everywhere else in
 * this schema where a tenant-scoped table's org column is NOT NULL by design (I4). Rows that DO
 * resolve to a real org are still readable only through `DocumentEmailIntakeRepository`'s own
 * explicit organization_id predicate (defense in depth matching this project's usual layered
 * approach), even without RLS enforcing it at the database layer.
 */
export const documentEmailIntakeStatusEnum = pgEnum('document_email_intake_status', [
  'ACCEPTED',
  'QUARANTINED_UNKNOWN_SENDER',
  'REJECTED_UNKNOWN_ORGANIZATION',
]);

export const documentEmailIntake = pgTable('document_email_intake', {
  id: idColumn(),
  organizationId: uuid('organization_id').references(() => organizations.id),
  status: documentEmailIntakeStatusEnum('status').notNull(),
  recipientAddress: text('recipient_address').notNull(),
  senderEmail: text('sender_email').notNull(),
  senderName: text('sender_name'),
  subject: text('subject'),
  attachmentCount: integer('attachment_count').notNull().default(0),
  // The full verified webhook payload (minus attachment bytes, which are stored separately per
  // attachment — see documentEmailIntakeAttachments) — an operator-visible audit trail for
  // reviewing WHY a sender was quarantined or an org was unresolved, matching how document_
  // extractions/webhook_events already keep a raw payload snapshot for the same reason.
  rawPayload: jsonb('raw_payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per attachment on a quarantined email — kept separate from `document_email_intake` so a
 * multi-attachment email's bytes don't bloat that table's own row, and so an accepted email's
 * attachments (which become real `documents` rows instead) never need this table at all. A
 * quarantined attachment's bytes are kept for a human reviewer to inspect and potentially release
 * from quarantine — never silently discarded,
 * since "we don't yet trust this sender" is not the same claim as "this attachment is worthless."
 */
export const documentEmailIntakeAttachments = pgTable('document_email_intake_attachments', {
  id: idColumn(),
  intakeId: uuid('intake_id')
    .notNull()
    .references(() => documentEmailIntake.id),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  storageKey: text('storage_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
