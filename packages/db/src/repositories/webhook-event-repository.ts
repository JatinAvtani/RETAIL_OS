import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { webhookEvents, type salesSourceEnum, type webhookEventTypeEnum } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

export type WebhookEventSource = (typeof salesSourceEnum.enumValues)[number];
export type WebhookEventType = (typeof webhookEventTypeEnum.enumValues)[number];

/**
 * 006-06's repository: `webhook_events`, the durable record of every verified, deduped webhook a
 * receiver has accepted. Proves the idempotency unique index `(organization_id, source,
 * external_event_id)` is real and load-bearing via `recordIfNew`'s `onConflictDoNothing` — a
 * retried delivery (guaranteed at-least-once by every vendor) must never be recorded twice.
 */
export class WebhookEventRepository extends TenantScopedRepository<typeof webhookEvents> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, webhookEvents, organizationId);
  }

  /**
   * Records a verified event idempotently. Returns `{ status: 'duplicate' }` when
   * `(organization, source, external_event_id)` already exists — the caller (the webhook route)
   * uses this to skip re-triggering the downstream sync for a retried delivery, never inferring it
   * from a thrown error.
   */
  async recordIfNew(input: {
    id: string;
    posConnectionId: string;
    source: WebhookEventSource;
    externalEventId: string;
    eventType: WebhookEventType;
    payload: unknown;
  }): Promise<{ status: 'duplicate' } | { status: 'recorded'; id: string }> {
    const rows = await this.runScoped((db) =>
      db
        .insert(webhookEvents)
        .values({
          id: input.id,
          organizationId: this.organizationId,
          posConnectionId: input.posConnectionId,
          source: input.source,
          externalEventId: input.externalEventId,
          eventType: input.eventType,
          payload: input.payload,
        })
        .onConflictDoNothing({
          target: [webhookEvents.organizationId, webhookEvents.source, webhookEvents.externalEventId],
        })
        .returning()
    );
    const created = rows[0];
    if (!created) {
      return { status: 'duplicate' };
    }
    return { status: 'recorded', id: created.id };
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(webhookEvents)
        .where(scopedWhere(eq(webhookEvents.id, id)))
    );
    return rows[0] ?? null;
  }

  /** Records the outcome of the post-response sync this event triggered — a real audit trail (006-13's eventual health surface) independent of whether the sync succeeded. */
  async markProcessed(id: string, error?: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(webhookEvents)
        .set({ processedAt: new Date(), processingError: error ?? null, updatedAt: new Date() })
        .where(scopedWhere(eq(webhookEvents.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }
}
