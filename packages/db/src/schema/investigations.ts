import { integer, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { notifications } from './notifications';
import { idColumn, timestamps } from './columns';

/**
  * one row per multi-hop investigation run (`runInvestigation`,
  * `packages/assistant/src/investigate.ts`) — created either on-demand (a user's free-form question)
  * or PROACTIVELY (a worker consumer reacting to a newly created `sales_anomaly`/
  * `supplier_price_increase`-typed notification, confirmed via `AskUserQuestion` to run fully
  * automatically rather than lazily on open). `sourceNotificationId` is null for an on-demand
  * investigation — there's no finding it's answering, just a user's question.
  *
  * `status` is what makes the proactive sweep idempotent: a notification already investigated
  * (`COMPLETE`/`FAILED`, both terminal) must never be investigated a second time on the next tick.
  *
  * `trace`/`draft` are JSONB — matching `messages.grounding_bundle`'s own established precedent for
  * persisting structured AI-pipeline output rather than normalizing every `InvestigationStep`/
  * `ActionDraftResult` field into its own column. `trace` is `InvestigationStep[]`
  * (`packages/assistant`'s own type); `draft` is `ActionDraftResult | null` — present only when the
  * investigation resolved to a real draft action, absent for an investigation that
  * only answered a question with no actionable follow-up.
  */
export const investigationStatusEnum = pgEnum('investigation_status', ['RUNNING', 'COMPLETE', 'FAILED', 'REJECTED']);
export type InvestigationStatus = (typeof investigationStatusEnum.enumValues)[number];

export const investigations = pgTable('investigations', {
  id: idColumn(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  storeId: uuid('store_id').references(() => stores.id),
  /** Null for an on-demand (user-asked) investigation — only a proactively-triggered one traces
  * back to the finding that started it. */
  sourceNotificationId: uuid('source_notification_id').references(() => notifications.id),
  question: text('question').notNull(),
  status: investigationStatusEnum('status').notNull().default('RUNNING'),
  hopCount: integer('hop_count').notNull().default(0),
  trace: jsonb('trace'),
  draft: jsonb('draft'),
  /** Set only on a genuine provider/pipeline error (I5 — distinct from a well-formed investigation
  * that simply found nothing actionable) — never a stand-in for "no draft was produced." */
  error: text('error'),
  ...timestamps,
});
