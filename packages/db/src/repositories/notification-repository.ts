import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { notificationRules, notifications, notificationDeliveries, type NotificationDeliveryStatus } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

/**
 * Schema-proving repository for the three notification tables, matching `ConversationRepository`'s
 * own stated precedent: prove the schema is real and correctly tenant-scoped with the minimal
 * operations that do so, not the full rule-evaluation/dedup/aggregation engine — that logic
 * belongs to the rule engine and dedup/aggregation modules, which decide dedup-key format and
 * aggregation semantics, not this repository. Each table carries its own `organizationId`, so each
 * gets its own plain `TenantScopedRepository` subclass, same shape as
 * `ConversationRepository`/`MessageRepository` — no join-based tenant predicate needed, and no
 * risk of the "scopedWhere bound to the wrong table" gotcha that shape avoids.
 */
export class NotificationRuleRepository extends TenantScopedRepository<typeof notificationRules> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, notificationRules, organizationId);
  }

  async create(input: {
    storeId?: string;
    ruleType: string;
    enabled?: boolean;
    threshold: unknown;
    severity: string;
    recipientRoles: string[];
    channels: string[];
    quietHours?: unknown;
  }): Promise<{ id: string }> {
    const id = generateId();
    await this.runScoped(async (db) => {
      await db.insert(notificationRules).values({
        id,
        organizationId: this.organizationId,
        ...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
        ruleType: input.ruleType,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        threshold: input.threshold,
        severity: input.severity,
        recipientRoles: input.recipientRoles,
        channels: input.channels,
        ...(input.quietHours !== undefined ? { quietHours: input.quietHours } : {}),
      });
    });
    return { id };
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(notificationRules)
        .where(scopedWhere(eq(notificationRules.id, id)))
    );
    return rows[0] ?? null;
  }

  /** Every enabled rule of a given type — the shape rule evaluation looks up on each real event. */
  async findEnabledByType(ruleType: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(notificationRules)
        .where(scopedWhere(and(eq(notificationRules.ruleType, ruleType), eq(notificationRules.enabled, true))))
    );
  }
}

export class NotificationRepository extends TenantScopedRepository<typeof notifications> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, notifications, organizationId);
  }

  /**
   * Throws on a genuine Postgres unique-violation if an unresolved notification with this exact
   * `dedupKey` already exists — the partial unique index (see the migration) makes "existing?
   * UPDATE, don't re-send" structurally enforced rather than a convention the caller must
   * remember. The dedup/aggregation module is the real caller that decides whether to catch that
   * violation and update instead; this method deliberately does not swallow it itself, since this
   * repository has no dedup POLICY of its own to enforce beyond what the DB already guarantees.
   */
  async create(input: {
    storeId?: string;
    ruleId: string;
    severity: string;
    title: string;
    body: string;
    dedupKey: string;
    aggregationGroup?: string;
    entityType?: string;
    entityId?: string;
    dollarImpact?: string;
  }): Promise<{ id: string }> {
    const id = generateId();
    await this.runScoped(async (db) => {
      await db.insert(notifications).values({
        id,
        organizationId: this.organizationId,
        ...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
        ruleId: input.ruleId,
        severity: input.severity,
        title: input.title,
        body: input.body,
        dedupKey: input.dedupKey,
        ...(input.aggregationGroup !== undefined ? { aggregationGroup: input.aggregationGroup } : {}),
        ...(input.entityType !== undefined ? { entityType: input.entityType } : {}),
        ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
        ...(input.dollarImpact !== undefined ? { dollarImpact: input.dollarImpact } : {}),
      });
    });
    return { id };
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(notifications)
        .where(scopedWhere(eq(notifications.id, id)))
    );
    return rows[0] ?? null;
  }

  /**
   * The real lookup `resolveDedupAction` (`@retailos/domain`) needs before deciding CREATE vs.
   * UPDATE vs. RESOLVE — "does an OPEN notification already exist for this exact dedup key." The
   * partial unique index guarantees at most one row can ever match (unresolved rows are unique per
   * dedup_key), so this returns a single row or `null`, never a list.
   */
  async findOpenByDedupKey(dedupKey: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(notifications)
        .where(scopedWhere(and(eq(notifications.dedupKey, dedupKey), isNull(notifications.resolvedAt))))
    );
    return rows[0] ?? null;
  }

  /** Every row (resolved and unresolved) ever created for a dedup key — proves the CREATE/RESOLVE/CREATE cycle produces distinct rows, not silently reusing one. */
  async findAllByDedupKey(dedupKey: string) {
    return this.runScoped((db, scopedWhere) => db.select().from(notifications).where(scopedWhere(eq(notifications.dedupKey, dedupKey))));
  }

  /**
   * Executes the `CREATE`/`UPDATE` half of `resolveDedupAction`'s decision as one real UPSERT
   * against the partial unique index — proved directly via raw `psql` before this method was
   * written (`ON CONFLICT (organization_id, dedup_key) WHERE resolved_at IS NULL DO UPDATE`
   * genuinely works, same row id survives a repeat firing). Never a separate
   * check-then-insert-or-update pair, which would race under concurrent evaluation of the same
   * dedup_key (two workers evaluating the same rule at once) — the database's own constraint is
   * the single source of truth for "does this already exist," not a prior `findOpenByDedupKey`
   * call in application code.
   */
  async upsertByDedupKey(input: {
    storeId?: string;
    ruleId: string;
    severity: string;
    title: string;
    body: string;
    dedupKey: string;
    aggregationGroup?: string;
    entityType?: string;
    entityId?: string;
    dollarImpact?: string;
  }): Promise<{ id: string }> {
    const id = generateId();
    const rows = await this.runScoped((db) =>
      db
        .insert(notifications)
        .values({
          id,
          organizationId: this.organizationId,
          ...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
          ruleId: input.ruleId,
          severity: input.severity,
          title: input.title,
          body: input.body,
          dedupKey: input.dedupKey,
          ...(input.aggregationGroup !== undefined ? { aggregationGroup: input.aggregationGroup } : {}),
          ...(input.entityType !== undefined ? { entityType: input.entityType } : {}),
          ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
          ...(input.dollarImpact !== undefined ? { dollarImpact: input.dollarImpact } : {}),
        })
        .onConflictDoUpdate({
          target: [notifications.organizationId, notifications.dedupKey],
          targetWhere: isNull(notifications.resolvedAt),
          set: {
            severity: input.severity,
            title: input.title,
            body: input.body,
            ...(input.aggregationGroup !== undefined ? { aggregationGroup: input.aggregationGroup } : {}),
            ...(input.dollarImpact !== undefined ? { dollarImpact: input.dollarImpact } : {}),
          },
        })
        .returning({ id: notifications.id })
    );
    const row = rows[0];
    if (!row) {
      throw new Error('Notification upsert returned no row.');
    }
    return { id: row.id };
  }

  /**
   * The in-app notification centre's real query shape: unresolved, most recent first — for a
   * given store, this includes BOTH that store's own notifications AND org-wide ones (`storeId:
   * NULL`), matching `notification_rules.storeId`'s own established "null means applies to every
   * store" semantics (a margin-drop alert fired at the org level must still show up when a manager
   * is looking at any one of their stores, not only get lost because it has no specific storeId).
   */
  async findUnresolvedForStore(storeId: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(notifications)
        .where(scopedWhere(and(or(eq(notifications.storeId, storeId), isNull(notifications.storeId)), isNull(notifications.resolvedAt))))
        .orderBy(desc(notifications.createdAt))
    );
  }

  /** The centre's unread badge count — unresolved AND unread, same store-or-org-wide scoping as `findUnresolvedForStore`. */
  async countUnreadForStore(storeId: string): Promise<number> {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          scopedWhere(
            and(
              or(eq(notifications.storeId, storeId), isNull(notifications.storeId)),
              isNull(notifications.resolvedAt),
              isNull(notifications.readAt)
            )
          )
        )
    );
    return rows.length;
  }

  async markResolved(id: string): Promise<void> {
    await this.runScoped(async (db, scopedWhere) => {
      await db
        .update(notifications)
        .set({ resolvedAt: new Date() })
        .where(scopedWhere(eq(notifications.id, id)));
    });
  }

  /** Idempotent — marking an already-read notification read again is a safe no-op, never overwrites an earlier real readAt with a later one. */
  async markRead(id: string): Promise<void> {
    await this.runScoped(async (db, scopedWhere) => {
      await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(scopedWhere(and(eq(notifications.id, id), isNull(notifications.readAt))));
    });
  }

  async markActed(id: string): Promise<void> {
    await this.runScoped(async (db, scopedWhere) => {
      await db
        .update(notifications)
        .set({ actedAt: new Date() })
        .where(scopedWhere(eq(notifications.id, id)));
    });
  }
}

export class NotificationDeliveryRepository extends TenantScopedRepository<typeof notificationDeliveries> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, notificationDeliveries, organizationId);
  }

  async create(input: { notificationId: string; userId: string; channel: string }): Promise<{ id: string }> {
    const id = generateId();
    await this.runScoped(async (db) => {
      await db.insert(notificationDeliveries).values({
        id,
        organizationId: this.organizationId,
        notificationId: input.notificationId,
        userId: input.userId,
        channel: input.channel,
      });
    });
    return { id };
  }

  /**
   * Deliveries still PENDING, for this org — the shape a future retry/DLQ queue scan needs.
   * Deliberately not "pending or failed": FAILED->retry policy (attempt counting, DLQ cutoff) is
   * that future work's own scope to design, not assumed here.
   */
  async findPending() {
    const pending: NotificationDeliveryStatus = 'PENDING';
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(notificationDeliveries)
        .where(scopedWhere(eq(notificationDeliveries.status, pending)))
    );
  }

  async findForUser(userId: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(notificationDeliveries)
        .where(scopedWhere(eq(notificationDeliveries.userId, userId)))
    );
  }

  async markDelivered(id: string): Promise<void> {
    await this.runScoped(async (db, scopedWhere) => {
      await db
        .update(notificationDeliveries)
        .set({ status: 'DELIVERED', deliveredAt: new Date() })
        .where(scopedWhere(eq(notificationDeliveries.id, id)));
    });
  }

  async markOpened(id: string): Promise<void> {
    await this.runScoped(async (db, scopedWhere) => {
      await db
        .update(notificationDeliveries)
        .set({ openedAt: new Date() })
        .where(scopedWhere(eq(notificationDeliveries.id, id)));
    });
  }
}
