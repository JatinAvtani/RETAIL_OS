import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { NotificationPreferenceRepository, NotificationRepository, NotificationRuleRepository, StoreRepository } from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import { computeActionRatesByRuleType, findRuleTypesNeedingTuning } from '@retailos/metrics';
import { DEFAULT_SEVERITY_BY_RULE_TYPE, type AlertRuleType } from '@retailos/domain';
import { protectedProcedure, router } from '../trpc';

const requirePermission = (permissions: string[], permission: string) => {
  if (!permissions.includes(permission)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
  }
};

const actionRateReportInput = z.object({
  days: z.number().int().min(1).max(365).default(30),
});

const updateRuleTuningInput = z.object({
  ruleId: z.string().uuid().nullable(),
  ruleType: z.string(),
  severity: z.enum(['INFO', 'MEDIUM', 'HIGH', 'CRITICAL']),
  recipientRoles: z.array(z.enum(['OWNER', 'MANAGER', 'STAFF', 'VIEWER_FINANCE'])).min(1),
  channels: z.array(z.enum(['EMAIL'])),
});

const hour = z.number().int().min(0).max(23);

/**
 * "Both set or neither" — a quiet-hours window is meaningless with only one bound. Enforced here
 * at the API boundary (not a DB CHECK constraint, matching this schema's own established
 * convention of trusting the write path for cross-column invariants), since this is the one real
 * write path a user-facing form calls.
 */
const updatePreferencesInput = z
  .object({
    mutedChannels: z.array(z.string()),
    quietHoursStartHour: hour.nullable(),
    quietHoursEndHour: hour.nullable(),
    criticalOverridesQuietHours: z.boolean(),
  })
  .refine(
    (v) => (v.quietHoursStartHour === null) === (v.quietHoursEndHour === null),
    { message: 'Quiet hours start/end must both be set or both be null.' }
  );

/**
 * The in-app notification centre's API surface: unread count, grouping, mark-read, direct action
 * links. Every write here is deliberately narrow: this router composes
 * `NotificationRepository`'s already-built methods, adding no new business logic of its own —
 * matching every other router's own "thin adapter over already-tested library code" shape.
 *
 * "Grouping" is NOT a query-time concern here — `aggregateNotificationContent` already collapses
 * multiple firings sharing one `aggregationGroup` into a single real `notifications` row at WRITE
 * time (e.g. 5 expiring lots become 1 notification, not 5). This router lists whatever real rows
 * already exist; the UI groups by `severity` for visual scannability, a presentation concern, not
 * a second aggregation mechanism.
 */
export const notificationsRouter = router({
  /** The in-app centre's real list — unresolved, store-or-org-wide, most recent first. */
  list: protectedProcedure.input(z.object({ storeId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const organizationId = ctx.session.organizationId;

    // The two-layer store check every other store-scoped procedure in this codebase uses
    // (assistant.briefing, purchase-orders.ts, inventory.ts...) — BOTH layers load-bearing:
    // canAccessStore alone accepts ANY org's storeId for a storeIds:'ALL' caller.
    const storeRepository = new StoreRepository(ctx.db, organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const notificationRepository = new NotificationRepository(ctx.db, organizationId);
    return notificationRepository.findUnresolvedForStore(input.storeId);
  }),

  /** The centre's unread badge — a cheap count query, same store-ownership check as `list`. */
  unreadCount: protectedProcedure.input(z.object({ storeId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const organizationId = ctx.session.organizationId;
    const storeRepository = new StoreRepository(ctx.db, organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const notificationRepository = new NotificationRepository(ctx.db, organizationId);
    const count = await notificationRepository.countUnreadForStore(input.storeId);
    return { count };
  }),

  /**
   * Idempotent (`NotificationRepository.markRead` only writes when `readAt IS NULL`) — a second
   * call for an already-read notification is a safe no-op, not an error, since a UI can plausibly
   * fire this more than once for the same id (a re-render, a race between two open tabs).
   */
  markRead: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const notificationRepository = new NotificationRepository(ctx.db, ctx.session.organizationId);
    const existing = await notificationRepository.findById(input.id);
    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Notification not found.' });
    }
    await notificationRepository.markRead(input.id);
    return { id: input.id };
  }),

  /**
   * The "direct action links" endpoint — records that a human took a genuine action on this
   * notification (e.g. followed a link to actually order more flour), distinct from merely having
   * seen it (`markRead`). Future action-rate tracking is the real eventual consumer of this
   * signal; for now this provides the write path a UI action button needs.
   */
  markActed: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const notificationRepository = new NotificationRepository(ctx.db, ctx.session.organizationId);
    const existing = await notificationRepository.findById(input.id);
    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Notification not found.' });
    }
    await notificationRepository.markActed(input.id);
    return { id: input.id };
  }),

  /**
   * A user's own preferences — always the CALLER's own row (`ctx.session.userId`), never a
   * target user id, so this needs no cross-tenant registry entry: there is no *Id-shaped input a
   * different tenant's session could substitute to read/write someone else's preferences. Real
   * default returned for a user with no configured row yet (I7 — "no preference set" is a genuine,
   * known state, not an unknown to guess at).
   */
  getPreferences: protectedProcedure.query(async ({ ctx }) => {
    const preferenceRepository = new NotificationPreferenceRepository(ctx.db, ctx.session.organizationId);
    return preferenceRepository.findOrDefaultForUser(ctx.session.userId);
  }),

  updatePreferences: protectedProcedure.input(updatePreferencesInput).mutation(async ({ ctx, input }) => {
    const preferenceRepository = new NotificationPreferenceRepository(ctx.db, ctx.session.organizationId);
    await preferenceRepository.upsertForUser(ctx.session.userId, input);
    return preferenceRepository.findOrDefaultForUser(ctx.session.userId);
  }),

  /**
   * The feedback-loop report — "action rate closes the loop." Org-wide,
   * no `*Id`-shaped input, so this is correctly exempt from the cross-tenant registry, matching
   * `documents.accuracyTelemetry`'s own precedent for this exact shape of report. Gated on
   * `financial:read` (confirmed with the user) — the same permission that already gates the owner
   * dashboard's other operational-health figures, since tuning alert thresholds is an owner/manager
   * decision, not a per-user preference.
   */
  actionRateReport: protectedProcedure.input(actionRateReportInput).query(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'financial:read');
    const notificationRepository = new NotificationRepository(ctx.db, ctx.session.organizationId);
    const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);
    const rows = await notificationRepository.findActionTrackingRowsSince(since);
    const byRuleType = computeActionRatesByRuleType(rows);
    return {
      byRuleType,
      needsTuning: findRuleTypesNeedingTuning(byRuleType),
    };
  }),

  /**
   * "Alert types with low action rates are surfaced for threshold tuning" made real. Joins
   * `findRuleTypesNeedingTuning`'s output with each flagged rule
   * type's real ORG-WIDE configured row (`storeId: null` — store-specific overrides exist but a
   * single org-wide tuning surface is this task's honest scope, matching `resolveApplicableRule`'s
   * own "org-wide row" concept). A rule type with no configured row yet gets a synthetic entry
   * (`ruleId: null`, the real catalogue default severity, no roles/channels pre-selected) so the
   * panel can still show and let an owner configure it for the first time — `updateRuleTuning`
   * below creates the row on first save, matching the stock-below-reorder path's own "auto-provision on first real need"
   * precedent rather than requiring a separate blank-state creation step.
   *
   * Deliberately does NOT return `threshold` at all — see `NotificationRuleRepository.updateTuning`
   * for why exposing it generically would be dishonest for most rule types today.
   */
  listTuningCandidates: protectedProcedure.input(actionRateReportInput).query(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'financial:read');
    const organizationId = ctx.session.organizationId;
    const notificationRepository = new NotificationRepository(ctx.db, organizationId);
    const ruleRepository = new NotificationRuleRepository(ctx.db, organizationId);

    const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);
    const [rows, rules] = await Promise.all([notificationRepository.findActionTrackingRowsSince(since), ruleRepository.findAll()]);
    const needsTuning = findRuleTypesNeedingTuning(computeActionRatesByRuleType(rows));

    return needsTuning.map((entry) => {
      const orgWideRule = rules.find((rule) => rule.ruleType === entry.ruleType && rule.storeId === null);
      return {
        ...entry,
        ruleId: orgWideRule?.id ?? null,
        severity: orgWideRule?.severity ?? DEFAULT_SEVERITY_BY_RULE_TYPE[entry.ruleType as AlertRuleType] ?? 'MEDIUM',
        recipientRoles: orgWideRule?.recipientRoles ?? ['MANAGER'],
        channels: orgWideRule?.channels ?? ['EMAIL'],
      };
    });
  }),

  /**
   * The tuning panel's real write path, gated on `settings:manage` (OWNER-exclusive) rather than
   * `financial:read` — changing what triggers an alert and who receives it is a configuration
   * mutation, not a read, matching `settings.ts`'s own established gating for this permission.
   * When `ruleId` is null (no row exists yet for this rule type), creates one first with the
   * caller's chosen values as the tenant's new org-wide configuration — never silently requires a
   * separate "create the rule" step the UI would otherwise need to expose.
   */
  updateRuleTuning: protectedProcedure.input(updateRuleTuningInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'settings:manage');
    const ruleRepository = new NotificationRuleRepository(ctx.db, ctx.session.organizationId);

    if (input.ruleId === null) {
      const { id } = await ruleRepository.create({
        ruleType: input.ruleType,
        threshold: {},
        severity: input.severity,
        recipientRoles: input.recipientRoles,
        channels: input.channels,
      });
      return { ruleId: id };
    }

    const existing = await ruleRepository.findById(input.ruleId);
    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Notification rule not found.' });
    }
    await ruleRepository.updateTuning(input.ruleId, {
      severity: input.severity,
      recipientRoles: input.recipientRoles,
      channels: input.channels,
    });
    return { ruleId: input.ruleId };
  }),
});
