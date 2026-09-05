import type { Job } from 'bullmq';
import { Decimal } from 'decimal.js';
import {
  InvoiceMatchRepository,
  NotificationRepository,
  NotificationRuleRepository,
  ParLevelRepository,
  PurchaseOrderRepository,
  StockLevelRepository,
  SupplierProductRepository,
  createDb,
} from '@retailos/db';
import {
  DEFAULT_SEVERITY_BY_RULE_TYPE,
  buildPoAwaitingApprovalDedupKey,
  evaluateInvoiceVariance,
  evaluatePoAwaitingApproval,
  evaluateStockBelowReorder,
  evaluateStocktakeVariance,
  evaluateSupplierPriceIncrease,
  resolveApplicableRule,
  resolveDedupAction,
  type AlertSeverity,
  type CandidateRule,
  type VarianceSeverityInput,
} from '@retailos/domain';
import type { RelayJobData } from '@retailos/queue';
import { notifyRecipients } from './notification-fanout';

/**
 * The real first consumer of the outbox relay — turns a relayed domain event into a real rule
 * evaluation, closing the loop `packages/domain`'s `resolveDedupAction`/
 * `evaluateStockBelowReorder` built with no caller yet. A thin adapter, matching
 * `createExtractionProcessor`'s established shape: BullMQ/event plumbing here, the actual decision
 * logic lives in `@retailos/domain`'s pure functions.
 *
 * Five event-driven rule types are wired here — every real outbox event this codebase already
 * emits that maps directly to one of the 12 catalogue rule types:
 *   - `stock.moved` -> `stock_below_reorder`
 *   - `supplier.price_changed` -> `supplier_price_increase` (only ever emitted by
 *     `PostingService.postLineInTx` AFTER `detectPriceChange` confirms a real, threshold-crossing
 *     change — the event itself already IS the significant-change fact, I2)
 *   - `match.variance_detected` -> `invoice_variance` (only fires when `classifyLineMatch`'s real
 *     per-line classification found something other than `NONE`)
 *   - `po.submitted` -> `po_awaiting_approval` (only ever emitted by
 *     `PurchaseOrderRepository.applyTransition` for a `SUBMIT` the PO state machine itself accepted)
 *   - `stocktake.submitted` -> `stocktake_variance` (only ever emitted by
 *     `StockCountService.submitCount` AFTER it has already computed every line's real variance and
 *     picked out the largest magnitude, I2)
 *
 * A sixth, resolve-only mapping closes the loop on the PO one: `po.approved`/`po.rejected`/
 * `po.cancelled` (also emitted by `applyTransition`, for the transitions of the same name) resolve
 * the still-open `po_awaiting_approval` notification directly by dedup key. This is NOT automatic —
 * a prior version of this file assumed dedup would "just handle it" once the PO left the awaiting
 * state, but dedup only re-evaluates when a matching event reaches the SAME handler again, and
 * these three event types were never wired to anything, so the alert stayed open forever after a
 * real approval/rejection/cancellation. `stocktake_variance` needs no equivalent resolve mapping — a
 * stock count is submitted exactly once and never re-opens, so its dedup key never goes stale.
 *
 * `lot_expiring`/`negative_stock`/`sales_anomaly`/`unmapped_pos_items`/`document_review_required`
 * are each time-based rather than event-driven (no "this just became true" domain event exists for
 * any of them) — see their own dedicated `apps/worker/src/*-sweep-processor.ts` files instead.
 * `margin_drop` remains genuinely unwired: no real statistical margin-anomaly detection exists
 * anywhere in this codebase to trigger it, and inventing one here would be exactly the kind of
 * fabricated business logic I1/I2 forbid.
 */
export const createRuleEvaluationProcessor = (config: { databaseUrl: string; redisUrl: string }) => {
  const { db } = createDb(config.databaseUrl);

  const evaluateStockBelowReorderFromEvent = async (event: RelayJobData): Promise<void> => {
    const payload = event.payload as { storeId?: unknown; productId?: unknown; variantId?: unknown };
    if (typeof payload.storeId !== 'string' || typeof payload.productId !== 'string' || typeof payload.variantId !== 'string') {
      // A malformed/unexpected stock.moved payload shape — skip rather than throw, since a bad
      // shape here is a data problem this processor cannot fix by retrying, and retrying
      // indefinitely on a permanently-malformed payload would just fill the DLQ pointlessly.
      console.error(`Rule evaluation: stock.moved event ${event.outboxEventId} has an unexpected payload shape`, event.payload);
      return;
    }
    const { storeId, productId, variantId } = payload;

    const stockLevelRepo = new StockLevelRepository(db, event.organizationId);
    const parLevelRepo = new ParLevelRepository(db, event.organizationId);

    const [stockLevel, parLevel] = await Promise.all([
      stockLevelRepo.find(storeId, productId, variantId),
      parLevelRepo.find(storeId, productId, variantId),
    ]);

    // No reorder point configured for this item at all — genuinely nothing to evaluate against,
    // not an "unknown" that should still surface a notification (I7: a missing threshold is a
    // configuration gap, not a fired alert).
    if (!parLevel?.reorderPoint) return;
    // No stock_levels row yet (a brand-new product with zero movements ever) — nothing on hand to
    // compare, same reasoning.
    if (!stockLevel) return;

    const ruleRepo = new NotificationRuleRepository(db, event.organizationId);
    const candidates = (await ruleRepo.findEnabledByType('stock_below_reorder')) as CandidateRule[];
    const applicableRule = resolveApplicableRule(candidates, storeId);
    const severity: AlertSeverity = (applicableRule?.severity as AlertSeverity | undefined) ?? DEFAULT_SEVERITY_BY_RULE_TYPE.stock_below_reorder;

    const evaluation = evaluateStockBelowReorder(
      { quantityOnHand: new Decimal(stockLevel.quantity), reorderPoint: new Decimal(parLevel.reorderPoint) },
      { storeId, productId, variantId },
      severity
    );

    const notificationRepo = new NotificationRepository(db, event.organizationId);
    const existing = await notificationRepo.findOpenByDedupKey(evaluation.dedupKey);
    const action = resolveDedupAction(evaluation.fires, existing);

    switch (action.kind) {
      case 'CREATE':
      case 'UPDATE': {
        // `notifications.rule_id` is NOT NULL, so a firing notification always needs a real row to
        // reference — confirmed with the user: when the tenant has configured NOTHING for this
        // rule type (`resolveApplicableRule` returned `null`), auto-provision a real
        // `notification_rules` row from the catalogue default (severity, a sensible
        // recipientRoles/channels pairing) THE FIRST TIME it's needed, rather than skipping
        // persistence — this is what makes the "sensible defaults... never silently skip
        // evaluation for lack of configuration" promise real at the persistence layer, not just in
        // the pure function's own tests. Every later fire of the same (org, ruleType) reuses this
        // now-real row via `findEnabledByType`/`resolveApplicableRule`, same as any other
        // tenant-configured rule; a tenant can see/edit it once the notification centre exists.
        const rule = applicableRule ?? (await ruleRepo.create({
          ruleType: 'stock_below_reorder',
          severity: DEFAULT_SEVERITY_BY_RULE_TYPE.stock_below_reorder,
          threshold: {},
          recipientRoles: ['MANAGER'],
          channels: ['EMAIL'],
        })) as { id: string };
        const ruleId = rule.id;
        const recipientRoles = applicableRule?.recipientRoles ?? ['MANAGER'];
        const channels = applicableRule?.channels ?? ['EMAIL'];

        const { id: notificationId } = await notificationRepo.upsertByDedupKey({
          storeId,
          ruleId,
          severity: evaluation.severity,
          title: `Stock below reorder point`,
          body: `Product ${productId} at store ${storeId} is at or below its configured reorder point.`,
          dedupKey: evaluation.dedupKey,
          entityType: 'product',
          entityId: productId,
        });

        // Fan-out only on a genuinely NEW notification — an UPDATE means the same open alert is
        // still firing and must not re-deliver (the plan's own fatigue-prevention rule).
        if (action.kind === 'CREATE') {
          await notifyRecipients(db, config.redisUrl, event.organizationId, notificationId, storeId, evaluation.severity, recipientRoles, channels);
        }
        break;
      }
      case 'RESOLVE':
        await notificationRepo.markResolved(action.existingId);
        break;
      case 'NO_OP':
        break;
    }
  };

  /**
   * `supplier.price_changed` -> `supplier_price_increase`. `PostingService.postLineInTx`
   * (`packages/db/src/repositories/posting-service.ts`) already ran `detectPriceChange` and only
   * emitted this event because the change crossed `DEFAULT_PRICE_CHANGE_THRESHOLD_PERCENT` — this
   * handler does not re-check that threshold, it turns the already-confirmed fact into a real
   * notification. `supplierProducts` carries no `storeId` (supplier pricing is an org-level
   * concept, not a per-store one), so the resulting notification is deliberately org-wide
   * (`storeId: null`), matching `resolveApplicableRule`'s own "null means every store" semantics.
   */
  const evaluateSupplierPriceIncreaseFromEvent = async (event: RelayJobData): Promise<void> => {
    const payload = event.payload as { supplierProductId?: unknown; annualizedImpact?: unknown };
    if (typeof payload.supplierProductId !== 'string') {
      console.error(`Rule evaluation: supplier.price_changed event ${event.outboxEventId} has an unexpected payload shape`, event.payload);
      return;
    }
    const { supplierProductId } = payload;

    const supplierProductRepo = new SupplierProductRepository(db, event.organizationId);
    const supplierProduct = await supplierProductRepo.findById(supplierProductId);
    // The supplier product was deleted/never resolved between the event being emitted and this
    // relay tick — nothing real left to attach a notification to.
    if (!supplierProduct) return;

    // Supplier pricing has no store dimension at all (`supplierProducts` carries no `storeId`), so
    // there is no per-store candidate to prefer — `resolveApplicableRule` exists specifically to
    // pick between a store-specific and an org-wide row given a real store, which doesn't apply
    // here; the only real candidate for an org-level rule type is the org-wide row itself
    // (`storeId: null`), found directly rather than routed through that store-preference function.
    const ruleRepo = new NotificationRuleRepository(db, event.organizationId);
    const candidates = (await ruleRepo.findEnabledByType('supplier_price_increase')) as CandidateRule[];
    const applicableRule = candidates.find((rule) => rule.storeId === null) ?? null;
    const severity: AlertSeverity = (applicableRule?.severity as AlertSeverity | undefined) ?? DEFAULT_SEVERITY_BY_RULE_TYPE.supplier_price_increase;

    // `annualizedImpact` is `'unknown'`-or-a-string on the outbox payload (`PostingService` writes
    // `null` for the JSON payload when `detectPriceChange` itself returned `'unknown'`, I7) — never
    // coerced to a fabricated 0.
    const annualizedImpact = typeof payload.annualizedImpact === 'string' ? new Decimal(payload.annualizedImpact) : null;

    const evaluation = evaluateSupplierPriceIncrease(
      { annualizedImpact },
      { supplierId: supplierProduct.supplierId, productId: supplierProduct.productId },
      severity
    );

    const notificationRepo = new NotificationRepository(db, event.organizationId);
    const existing = await notificationRepo.findOpenByDedupKey(evaluation.dedupKey);
    const action = resolveDedupAction(evaluation.fires, existing);

    switch (action.kind) {
      case 'CREATE':
      case 'UPDATE': {
        const rule = applicableRule ?? (await ruleRepo.create({
          ruleType: 'supplier_price_increase',
          severity: DEFAULT_SEVERITY_BY_RULE_TYPE.supplier_price_increase,
          threshold: {},
          recipientRoles: ['MANAGER'],
          channels: ['EMAIL'],
        })) as { id: string };
        const recipientRoles = applicableRule?.recipientRoles ?? ['MANAGER'];
        const channels = applicableRule?.channels ?? ['EMAIL'];

        const { id: notificationId } = await notificationRepo.upsertByDedupKey({
          ruleId: rule.id,
          severity: evaluation.severity,
          title: 'Supplier price increase',
          body: `A significant price change was posted for product ${supplierProduct.productId} from supplier ${supplierProduct.supplierId}.`,
          dedupKey: evaluation.dedupKey,
          entityType: 'supplier_product',
          entityId: supplierProductId,
          ...(evaluation.dollarImpact !== null ? { dollarImpact: evaluation.dollarImpact.toFixed(4) } : {}),
        });

        if (action.kind === 'CREATE') {
          await notifyRecipients(db, config.redisUrl, event.organizationId, notificationId, null, evaluation.severity, recipientRoles, channels);
        }
        break;
      }
      case 'RESOLVE':
        await notificationRepo.markResolved(action.existingId);
        break;
      case 'NO_OP':
        break;
    }
  };

  /**
   * `match.variance_detected` -> `invoice_variance`. `InvoiceMatchRepository.runMatchInTx`
   * (`packages/db/src/repositories/invoice-match-repository.ts`) already ran `classifyLineMatch`
   * against every line and rolled the result up into `highestSeverity` — this handler does not
   * re-classify anything, it only decides (`evaluateInvoiceVariance`) whether the already-computed
   * outcome is worth alerting on (i.e. not `'NONE'`, a clean match).
   */
  const evaluateInvoiceVarianceFromEvent = async (event: RelayJobData): Promise<void> => {
    const payload = event.payload as { invoiceMatchId?: unknown };
    if (typeof payload.invoiceMatchId !== 'string') {
      console.error(`Rule evaluation: match.variance_detected event ${event.outboxEventId} has an unexpected payload shape`, event.payload);
      return;
    }
    const { invoiceMatchId } = payload;

    const invoiceMatchRepo = new InvoiceMatchRepository(db, event.organizationId);
    const match = await invoiceMatchRepo.findById(invoiceMatchId);
    if (!match) return;

    const ruleRepo = new NotificationRuleRepository(db, event.organizationId);
    const candidates = (await ruleRepo.findEnabledByType('invoice_variance')) as CandidateRule[];
    const applicableRule = resolveApplicableRule(candidates, match.storeId);
    const severity: AlertSeverity = (applicableRule?.severity as AlertSeverity | undefined) ?? DEFAULT_SEVERITY_BY_RULE_TYPE.invoice_variance;

    const evaluation = evaluateInvoiceVariance(
      { highestSeverity: (match.highestSeverity ?? 'NONE') as VarianceSeverityInput },
      { invoiceMatchId },
      severity
    );

    const notificationRepo = new NotificationRepository(db, event.organizationId);
    const existing = await notificationRepo.findOpenByDedupKey(evaluation.dedupKey);
    const action = resolveDedupAction(evaluation.fires, existing);

    switch (action.kind) {
      case 'CREATE':
      case 'UPDATE': {
        const rule = applicableRule ?? (await ruleRepo.create({
          ruleType: 'invoice_variance',
          severity: DEFAULT_SEVERITY_BY_RULE_TYPE.invoice_variance,
          threshold: {},
          recipientRoles: ['MANAGER'],
          channels: ['EMAIL'],
        })) as { id: string };
        const recipientRoles = applicableRule?.recipientRoles ?? ['MANAGER'];
        const channels = applicableRule?.channels ?? ['EMAIL'];

        const { id: notificationId } = await notificationRepo.upsertByDedupKey({
          storeId: match.storeId,
          ruleId: rule.id,
          severity: evaluation.severity,
          title: 'Invoice variance detected',
          body: `The three-way match for document ${match.documentId} found a variance (${match.highestSeverity ?? 'unknown'} severity).`,
          dedupKey: evaluation.dedupKey,
          entityType: 'invoice_match',
          entityId: invoiceMatchId,
        });

        if (action.kind === 'CREATE') {
          await notifyRecipients(db, config.redisUrl, event.organizationId, notificationId, match.storeId, evaluation.severity, recipientRoles, channels);
        }
        break;
      }
      case 'RESOLVE':
        await notificationRepo.markResolved(action.existingId);
        break;
      case 'NO_OP':
        break;
    }
  };

  /**
   * `po.submitted` -> `po_awaiting_approval`. `PurchaseOrderRepository.applyTransition` only ever
   * emits this event for a `SUBMIT` the PO state machine (`applyPurchaseOrderTransition`) already
   * accepted — the event itself is the fact, so `evaluatePoAwaitingApproval` always fires.
   */
  const evaluatePoAwaitingApprovalFromEvent = async (event: RelayJobData): Promise<void> => {
    const payload = event.payload as { purchaseOrderId?: unknown };
    if (typeof payload.purchaseOrderId !== 'string') {
      console.error(`Rule evaluation: po.submitted event ${event.outboxEventId} has an unexpected payload shape`, event.payload);
      return;
    }
    const { purchaseOrderId } = payload;

    const poRepo = new PurchaseOrderRepository(db, event.organizationId);
    const po = await poRepo.findById(purchaseOrderId);
    if (!po) return;

    const ruleRepo = new NotificationRuleRepository(db, event.organizationId);
    const candidates = (await ruleRepo.findEnabledByType('po_awaiting_approval')) as CandidateRule[];
    const applicableRule = resolveApplicableRule(candidates, po.storeId);
    const severity: AlertSeverity = (applicableRule?.severity as AlertSeverity | undefined) ?? DEFAULT_SEVERITY_BY_RULE_TYPE.po_awaiting_approval;

    const evaluation = evaluatePoAwaitingApproval({ purchaseOrderId }, severity);

    const notificationRepo = new NotificationRepository(db, event.organizationId);
    const existing = await notificationRepo.findOpenByDedupKey(evaluation.dedupKey);
    const action = resolveDedupAction(evaluation.fires, existing);

    switch (action.kind) {
      case 'CREATE':
      case 'UPDATE': {
        const rule = applicableRule ?? (await ruleRepo.create({
          ruleType: 'po_awaiting_approval',
          severity: DEFAULT_SEVERITY_BY_RULE_TYPE.po_awaiting_approval,
          threshold: {},
          recipientRoles: ['MANAGER'],
          channels: ['EMAIL'],
        })) as { id: string };
        const recipientRoles = applicableRule?.recipientRoles ?? ['MANAGER'];
        const channels = applicableRule?.channels ?? ['EMAIL'];

        const { id: notificationId } = await notificationRepo.upsertByDedupKey({
          storeId: po.storeId,
          ruleId: rule.id,
          severity: evaluation.severity,
          title: 'Purchase order awaiting approval',
          body: `Purchase order ${po.poNumber} is awaiting approval.`,
          dedupKey: evaluation.dedupKey,
          entityType: 'purchase_order',
          entityId: purchaseOrderId,
        });

        if (action.kind === 'CREATE') {
          await notifyRecipients(db, config.redisUrl, event.organizationId, notificationId, po.storeId, evaluation.severity, recipientRoles, channels);
        }
        break;
      }
      case 'RESOLVE':
        await notificationRepo.markResolved(action.existingId);
        break;
      case 'NO_OP':
        break;
    }
  };

  /**
   * `po.approved` / `po.rejected` / `po.cancelled` -> resolve the still-open `po_awaiting_approval`
   * notification for the same PO. This was a real gap, not a naturally self-resolving one: the doc
   * comment above `evaluatePoAwaitingApprovalFromEvent` used to claim "the dedup mechanism itself
   * resolves the still-open notification correctly once the PO is no longer genuinely awaiting
   * approval" — but `resolveDedupAction`/dedup keys only ever get RE-EVALUATED when a matching event
   * reaches the SAME handler again, and `po.approved`/`po.rejected`/`po.cancelled` never did (they
   * fell into the processor's `default` no-op branch below). A manager approving a PO produced a
   * real `po.approved` outbox event that this processor silently ignored, leaving the "awaiting
   * approval" alert open forever. This handler is deliberately resolve-only (never CREATE/UPDATE):
   * these events mean the PO is no longer awaiting approval, so there is nothing to newly evaluate,
   * only a stale alert to close if one is still open.
   */
  const resolvePoAwaitingApprovalFromEvent = async (event: RelayJobData): Promise<void> => {
    const payload = event.payload as { purchaseOrderId?: unknown };
    if (typeof payload.purchaseOrderId !== 'string') {
      console.error(`Rule evaluation: ${event.eventType} event ${event.outboxEventId} has an unexpected payload shape`, event.payload);
      return;
    }
    const { purchaseOrderId } = payload;

    const notificationRepo = new NotificationRepository(db, event.organizationId);
    const dedupKey = buildPoAwaitingApprovalDedupKey(purchaseOrderId);
    const existing = await notificationRepo.findOpenByDedupKey(dedupKey);
    if (existing) {
      await notificationRepo.markResolved(existing.id);
    }
  };

  /**
   * `stocktake.submitted` -> `stocktake_variance`. `StockCountService.submitCount` (`packages/db`)
   * already computed every line's real variance and picked out the single largest magnitude before
   * emitting this event — this handler does not recompute anything, it only decides
   * (`evaluateStocktakeVariance`) whether that already-known magnitude clears the shared
   * `LARGE_VARIANCE_THRESHOLD` bar (I2). Fires at most once per count: a count is submitted exactly
   * once, so there is no later re-evaluation of the same dedup key the way a sweep-driven rule type
   * would have.
   */
  const evaluateStocktakeVarianceFromEvent = async (event: RelayJobData): Promise<void> => {
    const payload = event.payload as {
      stockCountId?: unknown;
      storeId?: unknown;
      maxVarianceMagnitude?: unknown;
      largestVarianceDollarValue?: unknown;
    };
    if (typeof payload.stockCountId !== 'string' || typeof payload.storeId !== 'string') {
      console.error(`Rule evaluation: stocktake.submitted event ${event.outboxEventId} has an unexpected payload shape`, event.payload);
      return;
    }
    const { stockCountId, storeId } = payload;
    const maxVarianceMagnitude = typeof payload.maxVarianceMagnitude === 'string' ? payload.maxVarianceMagnitude : null;
    const largestVarianceDollarValue = typeof payload.largestVarianceDollarValue === 'string' ? payload.largestVarianceDollarValue : null;

    const ruleRepo = new NotificationRuleRepository(db, event.organizationId);
    const candidates = (await ruleRepo.findEnabledByType('stocktake_variance')) as CandidateRule[];
    const applicableRule = resolveApplicableRule(candidates, storeId);
    const severity: AlertSeverity = (applicableRule?.severity as AlertSeverity | undefined) ?? DEFAULT_SEVERITY_BY_RULE_TYPE.stocktake_variance;

    const evaluation = evaluateStocktakeVariance({ maxVarianceMagnitude, largestVarianceDollarValue }, { stockCountId }, severity);
    if (!evaluation.fires) return;

    const notificationRepo = new NotificationRepository(db, event.organizationId);
    const existing = await notificationRepo.findOpenByDedupKey(evaluation.dedupKey);
    const action = resolveDedupAction(evaluation.fires, existing);

    if (action.kind !== 'CREATE' && action.kind !== 'UPDATE') return;

    const rule = applicableRule ?? (await ruleRepo.create({
      ruleType: 'stocktake_variance',
      severity: DEFAULT_SEVERITY_BY_RULE_TYPE.stocktake_variance,
      threshold: {},
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    })) as { id: string };
    const recipientRoles = applicableRule?.recipientRoles ?? ['MANAGER'];
    const channels = applicableRule?.channels ?? ['EMAIL'];

    const { id: notificationId } = await notificationRepo.upsertByDedupKey({
      storeId,
      ruleId: rule.id,
      severity: evaluation.severity,
      title: 'Stocktake variance detected',
      body: `A submitted stock count found a variance of ${maxVarianceMagnitude !== null ? `${(Number(maxVarianceMagnitude) * 100).toFixed(1)}%` : 'an unknown magnitude'} on at least one line — review before approving.`,
      dedupKey: evaluation.dedupKey,
      entityType: 'stock_count',
      entityId: stockCountId,
      ...(evaluation.dollarImpact !== null ? { dollarImpact: evaluation.dollarImpact.toFixed(4) } : {}),
    });

    if (action.kind === 'CREATE') {
      await notifyRecipients(db, config.redisUrl, event.organizationId, notificationId, storeId, evaluation.severity, recipientRoles, channels);
    }
  };

  return async (job: Job<RelayJobData>): Promise<void> => {
    const event = job.data;
    switch (event.eventType) {
      case 'stock.moved':
        await evaluateStockBelowReorderFromEvent(event);
        return;
      case 'supplier.price_changed':
        await evaluateSupplierPriceIncreaseFromEvent(event);
        return;
      case 'match.variance_detected':
        await evaluateInvoiceVarianceFromEvent(event);
        return;
      case 'po.submitted':
        await evaluatePoAwaitingApprovalFromEvent(event);
        return;
      case 'po.approved':
      case 'po.rejected':
      case 'po.cancelled':
        await resolvePoAwaitingApprovalFromEvent(event);
        return;
      case 'stocktake.submitted':
        await evaluateStocktakeVarianceFromEvent(event);
        return;
      default:
        // Every other relayed event type has no rule-evaluation mapping yet — a deliberate no-op,
        // not a dropped event: the relay itself already marked it published (its job is delivery,
        // not interpretation), and this processor's contract is "evaluate what I understand,
        // ignore what I don't" rather than throwing on an unrecognized type, which would retry
        // forever into the DLQ for an event this processor was never meant to act on.
        return;
    }
  };
};
