// Loads .env.local so this script runs straight from a fresh clone (see load-env.ts).
import '@retailos/config/auto';
/**
 * The last of Part 2: the domains a user ENGAGES with rather than operates —
 * notification rules and the alerts they raise, assistant conversation history, and CSV import
 * history.
 *
 * NOTIFICATIONS ARE DRIVEN BY THE REAL RULE ENGINE. Every alert here comes from calling
 * `evaluateStockBelowReorder` / `evaluateLotExpiring` in `@retailos/domain` against REAL rows —
 * genuine stock levels below genuine par levels, genuine lots approaching genuine expiry dates —
 * and only writing a notification when the evaluator actually returns `fires: true`. Hand-writing
 * plausible alert text would demo a notification centre that is really a list of strings; this way
 * every alert on screen is one a real evaluation produced, with the engine's own dedup key and
 * severity.
 *
 * IDEMPOTENT: notifications are written through `upsertByDedupKey`, which is the same dedup path
 * production uses, so re-running updates rather than duplicates. Rules, conversations and imports
 * are each guarded on existing rows.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @retailos/api exec tsx src/scripts/seed-demo-engagement.mts
 *
 * Flags:
 *   --skip-assistant-history   do not seed full-corpus answers into a bounded quick-demo dataset
 */
import {
  createDb,
  organizations,
  stores,
  users,
  products,
  memberships,
  notifications,
  notificationDeliveries,
  lots,
  stockLevels,
  stockParLevels,
  NotificationRuleRepository,
  NotificationRepository,
  NotificationDeliveryRepository,
  ConversationRepository,
  MessageRepository,
  CsvImportRepository,
} from '@retailos/db';
import {
  evaluateStockBelowReorder,
  evaluateLotExpiring,
  DEFAULT_SEVERITY_BY_RULE_TYPE,
} from '@retailos/domain';
import Decimal from 'decimal.js';
import { and, eq, isNotNull } from 'drizzle-orm';

const SKIP_ASSISTANT_HISTORY = process.argv.includes('--skip-assistant-history');
const { db, client } = createDb(process.env.DATABASE_URL!);

const [org] = await db.select().from(organizations).where(eq(organizations.slug, 'third-wave-bengaluru'));
if (!org) {
  console.error('Demo organization not found. Run seed-demo.mts first.');
  process.exit(1);
}
const organizationId = org.id;

const [demoUser] = await db.select().from(users).where(eq(users.email, 'demo@vyapaar.test'));
if (!demoUser) {
  console.error('Demo user not found.');
  process.exit(1);
}

const storeRows = await db.select().from(stores).where(eq(stores.organizationId, organizationId));
const storeById = new Map(storeRows.map((s) => [s.id, s]));
const productRows = await db.select().from(products).where(eq(products.organizationId, organizationId));
const productById = new Map(productRows.map((p) => [p.id, p]));

const ruleRepo = new NotificationRuleRepository(db, organizationId);
const notificationRepo = new NotificationRepository(db, organizationId);
const deliveryRepo = new NotificationDeliveryRepository(db, organizationId);
const conversationRepo = new ConversationRepository(db, organizationId);
const messageRepo = new MessageRepository(db, organizationId);
const csvRepo = new CsvImportRepository(db, organizationId);

const started = Date.now();
const log = (stage: string, detail?: unknown) =>
  console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${stage}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);

/* ------------------------------------------------------------------ 1. notification rules */

/**
 * A rule row is what makes an alert type CONFIGURABLE — severity, who receives it, on which
 * channels. Without rows the engine falls back to catalogue defaults and the settings screen has
 * nothing to show.
 */
const RULES: { ruleType: string; threshold: unknown; severity: string; recipientRoles: string[]; channels: string[] }[] = [
  { ruleType: 'stock_below_reorder', threshold: {}, severity: DEFAULT_SEVERITY_BY_RULE_TYPE.stock_below_reorder, recipientRoles: ['OWNER', 'MANAGER'], channels: ['IN_APP', 'EMAIL'] },
  { ruleType: 'lot_expiring', threshold: { withinDays: 3 }, severity: DEFAULT_SEVERITY_BY_RULE_TYPE.lot_expiring, recipientRoles: ['OWNER', 'MANAGER'], channels: ['IN_APP'] },
  { ruleType: 'supplier_price_increase', threshold: { percent: 5 }, severity: DEFAULT_SEVERITY_BY_RULE_TYPE.supplier_price_increase, recipientRoles: ['OWNER'], channels: ['IN_APP', 'EMAIL'] },
  { ruleType: 'invoice_variance', threshold: {}, severity: DEFAULT_SEVERITY_BY_RULE_TYPE.invoice_variance, recipientRoles: ['OWNER'], channels: ['IN_APP'] },
  { ruleType: 'document_review_required', threshold: {}, severity: DEFAULT_SEVERITY_BY_RULE_TYPE.document_review_required, recipientRoles: ['OWNER', 'MANAGER'], channels: ['IN_APP'] },
  { ruleType: 'daily_briefing', threshold: {}, severity: DEFAULT_SEVERITY_BY_RULE_TYPE.daily_briefing, recipientRoles: ['OWNER'], channels: ['IN_APP', 'EMAIL'] },
];

const existingRules = await ruleRepo.findAll();
const ruleIdByType = new Map(existingRules.map((r) => [r.ruleType, r.id]));
let rulesCreated = 0;
for (const rule of RULES) {
  if (ruleIdByType.has(rule.ruleType)) continue;
  const created = await ruleRepo.create({
    ruleType: rule.ruleType,
    threshold: rule.threshold,
    severity: rule.severity,
    recipientRoles: rule.recipientRoles,
    channels: rule.channels,
    enabled: true,
  });
  ruleIdByType.set(rule.ruleType, created.id);
  rulesCreated += 1;
}
log('notification rules', { created: rulesCreated, total: ruleIdByType.size });

/* ------------------------------------------------------------------ 2. alerts, from the real engine */

const inr = (n: Decimal | number) => `INR ${new Decimal(n).toFixed(2)}`;

/** stock_below_reorder — evaluated against real stock levels vs real par levels. */
const parRows = await db
  .select({
    storeId: stockParLevels.storeId,
    productId: stockParLevels.productId,
    variantId: stockParLevels.variantId,
    reorderPoint: stockParLevels.reorderPoint,
  })
  .from(stockParLevels)
  .where(and(eq(stockParLevels.organizationId, organizationId), isNotNull(stockParLevels.reorderPoint)));

const levelRows = await db
  .select({ storeId: stockLevels.storeId, productId: stockLevels.productId, quantity: stockLevels.quantity })
  .from(stockLevels)
  .where(eq(stockLevels.organizationId, organizationId));
const levelByKey = new Map(levelRows.map((r) => [`${r.storeId}:${r.productId}`, new Decimal(r.quantity)]));

const reorderRuleId = ruleIdByType.get('stock_below_reorder')!;
let reorderAlerts = 0;
let reorderEvaluated = 0;

for (const par of parRows) {
  const onHand = levelByKey.get(`${par.storeId}:${par.productId}`);
  if (onHand === undefined) continue;
  reorderEvaluated += 1;

  // The REAL evaluator decides. If it says the rule does not fire, no notification is written —
  // which is why the alert list below is shorter than the candidate list, exactly as in production.
  const verdict = evaluateStockBelowReorder(
    { quantityOnHand: onHand, reorderPoint: new Decimal(par.reorderPoint!) },
    { storeId: par.storeId, productId: par.productId, variantId: par.variantId }
  );
  if (!verdict.fires) continue;

  const product = productById.get(par.productId);
  const store = storeById.get(par.storeId);
  if (!product || !store) continue;

  await notificationRepo.upsertByDedupKey({
    storeId: par.storeId,
    ruleId: reorderRuleId,
    severity: verdict.severity,
    title: `${product.name} is at or below its reorder point`,
    body: `${store.name} has ${onHand.toFixed(0)} on hand against a reorder point of ${new Decimal(par.reorderPoint!).toFixed(0)}. Raise a purchase order before it runs out.`,
    dedupKey: verdict.dedupKey,
    entityType: 'product',
    entityId: par.productId,
  });
  reorderAlerts += 1;
}
log('stock_below_reorder', { evaluated: reorderEvaluated, fired: reorderAlerts });

/** lot_expiring — evaluated against real lots with real expiry dates. */
const lotRows = await db
  .select({
    id: lots.id,
    storeId: lots.storeId,
    productId: lots.productId,
    quantity: lots.remainingQuantity,
    unitCost: lots.unitCost,
    expiryDate: lots.expiryDate,
  })
  .from(lots)
  .where(and(eq(lots.organizationId, organizationId), isNotNull(lots.expiryDate)));

const expiryRuleId = ruleIdByType.get('lot_expiring')!;
const EXPIRY_WITHIN_DAYS = 3;
let expiryAlerts = 0;
let expiryEvaluated = 0;

/** Aggregated per store per day: the engine's own dedup key is `expiry:{storeId}:{localDate}`, so one alert covers a store's expiring stock rather than spamming one per lot. */
const expiringByStoreDate = new Map<string, { storeId: string; localDate: string; value: Decimal; lots: number; soonest: number }>();

for (const lot of lotRows) {
  /**
   * No `?? 0` on either field, deliberately.
   *
   * `lots.remaining_quantity` and `lots.unit_cost` are both NOT NULL, so a null here would mean the
   * schema changed under this code. Coercing to zero in a VALUE-AT-RISK calculation is precisely the
   * I7 failure: an unknown cost would silently report "INR 0.00 at risk" and the alert would
   * understate the exposure it exists to warn about. Skipping the lot and saying so is honest;
   * quietly valuing it at zero is not.
   */
  if (lot.quantity === null || lot.unitCost === null) {
    console.warn(`  lot ${lot.id} has a null quantity or unit cost — skipped rather than valued at zero.`);
    continue;
  }
  const remaining = new Decimal(lot.quantity);
  if (remaining.lessThanOrEqualTo(0)) continue;
  const daysToExpiry = Math.round((new Date(`${lot.expiryDate!}T00:00:00Z`).getTime() - Date.now()) / 86400000);
  if (daysToExpiry < 0) continue; // already expired — a different concern from "expiring soon"
  expiryEvaluated += 1;

  const valueAtRisk = remaining.times(new Decimal(lot.unitCost));
  const verdict = evaluateLotExpiring(
    { valueAtRisk, daysToExpiry },
    { storeId: lot.storeId, localDate: new Date().toISOString().slice(0, 10) },
    { withinDays: EXPIRY_WITHIN_DAYS }
  );
  if (!verdict.fires) continue;

  const key = verdict.dedupKey;
  const current = expiringByStoreDate.get(key);
  if (current) {
    current.value = current.value.plus(valueAtRisk);
    current.lots += 1;
    current.soonest = Math.min(current.soonest, daysToExpiry);
  } else {
    expiringByStoreDate.set(key, {
      storeId: lot.storeId,
      localDate: new Date().toISOString().slice(0, 10),
      value: valueAtRisk,
      lots: 1,
      soonest: daysToExpiry,
    });
  }
}

for (const [dedupKey, agg] of expiringByStoreDate) {
  const store = storeById.get(agg.storeId);
  if (!store) continue;
  await notificationRepo.upsertByDedupKey({
    storeId: agg.storeId,
    ruleId: expiryRuleId,
    severity: DEFAULT_SEVERITY_BY_RULE_TYPE.lot_expiring,
    title: `${agg.lots} lot${agg.lots === 1 ? '' : 's'} expiring within ${EXPIRY_WITHIN_DAYS} days at ${store.name}`,
    body: `${inr(agg.value)} of stock expires in ${agg.soonest} day${agg.soonest === 1 ? '' : 's'}. Use it, discount it, or expect to write it off.`,
    dedupKey,
    // The value genuinely at risk — a real figure from real lots, not an estimate.
    dollarImpact: agg.value.toFixed(4),
  });
  expiryAlerts += 1;
}
log('lot_expiring', { evaluated: expiryEvaluated, fired: expiryAlerts });

/* ------------------------------------------------------------------ 2b. delivery fan-out */

/**
 * One delivery row per (notification, recipient, channel) — the real fan-out shape.
 *
 * Recipients and channels are NOT invented here: each is read from the rule that actually raised the
 * alert (`recipientRoles`, `channels`), then intersected with the org's real memberships. A rule
 * targeting OWNER and MANAGER on IN_APP and EMAIL produces exactly the rows the outbox relay would
 * produce for the members who genuinely hold those roles.
 *
 * IN_APP is marked DELIVERED (the notification centre renders it the moment it exists). EMAIL is
 * left PENDING, honestly: no email was actually sent, and marking it SENT would claim a delivery
 * that never happened.
 */
const memberRows = await db
  .select({ userId: memberships.userId, role: memberships.role })
  .from(memberships)
  .where(eq(memberships.organizationId, organizationId));

const allNotifications = await db
  .select({ id: notifications.id, ruleId: notifications.ruleId })
  .from(notifications)
  .where(eq(notifications.organizationId, organizationId));

const rulesById = new Map(
  (await ruleRepo.findAll()).map((r) => [r.id, r as { id: string; recipientRoles: string[]; channels: string[] }])
);

const existingDeliveries = await db
  .select({ notificationId: notificationDeliveries.notificationId, userId: notificationDeliveries.userId, channel: notificationDeliveries.channel })
  .from(notificationDeliveries)
  .where(eq(notificationDeliveries.organizationId, organizationId));
const deliveryKeys = new Set(existingDeliveries.map((d) => `${d.notificationId}:${d.userId}:${d.channel}`));

let deliveriesCreated = 0;
for (const notification of allNotifications) {
  const rule = rulesById.get(notification.ruleId);
  if (!rule) continue;
  for (const member of memberRows) {
    if (!rule.recipientRoles.includes(member.role)) continue;
    for (const channel of rule.channels) {
      const key = `${notification.id}:${member.userId}:${channel}`;
      if (deliveryKeys.has(key)) continue;
      const created = await deliveryRepo.create({
        notificationId: notification.id,
        userId: member.userId,
        channel,
      });
      // In-app is genuinely delivered on write; email is not, and is left PENDING to say so.
      if (channel === 'IN_APP') await deliveryRepo.markDelivered(created.id);
      deliveryKeys.add(key);
      deliveriesCreated += 1;
    }
  }
}
log('notification deliveries', { created: deliveriesCreated });

/* ------------------------------------------------------------------ 3. assistant conversations */

/**
 * Conversation history so the assistant does not open blank. The questions are ones this dataset can
 * actually answer, and the answers quote figures that are really in it — an assistant transcript
 * citing numbers the database does not contain would be the exact fabrication this product forbids.
 */
const existingConversations = await conversationRepo.findForUser(demoUser.id);
let conversationsCreated = 0;
let messagesCreated = 0;

if (!SKIP_ASSISTANT_HISTORY && existingConversations.length === 0) {
  const TRANSCRIPTS: { title: string; turns: { role: 'USER' | 'ASSISTANT'; content: string }[] }[] = [
    {
      title: 'Where did my margin go last month?',
      turns: [
        { role: 'USER', content: 'Where did my margin go last month?' },
        {
          role: 'ASSISTANT',
          content:
            'Contribution margin ran at 73.71% across the last 30 days on INR 23.1 lakh of net revenue, with food cost at 26.29%.\n\nThe clearest pressure is on the purchasing side: Shree Balaji Traders has raised staple prices roughly 13% across the window — idli rava, sugar, atta and toor dal all stepped up. Those feed your highest-volume items (dosa, idli, filter coffee), so the increase reaches a large share of covers.\n\nI cannot give you a single cost-variance figure for the period: Vanilla milkshake is sold but has no confirmed cost for vanilla extract, so theoretical COGS for the period is genuinely unknown rather than estimated.',
        },
      ],
    },
    {
      title: 'Which supplier is causing problems?',
      turns: [
        { role: 'USER', content: 'Which supplier is causing problems?' },
        {
          role: 'ASSISTANT',
          content:
            'Green Valley Farms, on delivery reliability rather than price.\n\nOver the last 90 days their on-time rate is 57.1% and fill rate 96.7%, against 100% on both for every other supplier. The pattern is a decline, not a constant: the five deliveries before roughly a month ago all arrived on time and complete, while the three most recent were each both late and short.\n\nBecause they supply produce, a late delivery has a short shelf-life consequence — which lines up with the expiry write-offs at Koramangala.',
        },
      ],
    },
    {
      title: 'Why is Koramangala behind?',
      turns: [
        { role: 'USER', content: 'Why is Koramangala behind the other outlets?' },
        {
          role: 'ASSISTANT',
          content:
            'Two separate reasons, and only one is a problem.\n\nFirst, scale: Koramangala took INR 9.2 lakh over the last 30 days against Indiranagar\'s INR 24.1 lakh. It also opened partway through the window, so it has a genuinely shorter trading history — not underperformance, just less time.\n\nSecond, and worth acting on: its expiry write-offs are concentrated rather than spread out, with paneer and coriander written off on consecutive days. That points at a specific event — over-ordering or a storage failure — rather than a steady rate.',
        },
      ],
    },
  ];

  for (const transcript of TRANSCRIPTS) {
    const conversation = await conversationRepo.create({ userId: demoUser.id, title: transcript.title });
    conversationsCreated += 1;
    for (const turn of transcript.turns) {
      await messageRepo.create({
        conversationId: conversation.id,
        role: turn.role,
        content: turn.content,
        ...(turn.role === 'ASSISTANT' ? { modelVersion: 'seed-corpus', promptVersion: '1' } : {}),
      });
      messagesCreated += 1;
    }
  }
}
log('assistant history', {
  skipped: SKIP_ASSISTANT_HISTORY,
  conversations: conversationsCreated,
  messages: messagesCreated,
});

/* ------------------------------------------------------------------ 4. CSV import history */

/**
 * Import history so the sales-import screen shows a real past rather than an empty state — including
 * one import that partially failed, because a history where every import succeeded teaches the user
 * nothing about what a failure looks like.
 */
const existingImports = await csvRepo.findAllForOrganization();
let importsCreated = 0;

if (existingImports.length === 0) {
  const flagship = storeRows.find((s) => s.name === 'Indiranagar')!;
  const IMPORTS = [
    { key: 'sales-2026-06-week1.csv', total: 1482, imported: 1482, quarantined: 0, skipped: 0, fail: null },
    { key: 'sales-2026-07-week2.csv', total: 1610, imported: 1587, quarantined: 23, skipped: 0, fail: null },
    { key: 'sales-2026-08-week1.csv', total: 1544, imported: 1544, quarantined: 0, skipped: 0, fail: null },
    { key: 'sales-2026-08-partial.csv', total: 0, imported: 0, quarantined: 0, skipped: 0, fail: 'Row 214: could not parse "occurred_at" — expected ISO 8601, found "14-08-2026 9:15 PM".' },
  ];

  for (const spec of IMPORTS) {
    const created = await csvRepo.create({
      storeId: flagship.id,
      storageKey: `demo/imports/${spec.key}`,
      uploadedByUserId: demoUser.id,
    });
    await csvRepo.recordDetectedHeaders(created.id, {
      headers: ['occurred_at', 'item_name', 'quantity', 'unit_price', 'total'],
      sampleRows: [['2026-08-01T09:12:00Z', 'FILTER COFFEE', '2', '35.00', '70.00']],
      delimiter: ',',
    });
    await csvRepo.recordColumnMapping(created.id, {
      occurred_at: 'occurredAt',
      item_name: 'posItemName',
      quantity: 'quantity',
      unit_price: 'unitPrice',
      total: 'lineTotal',
    });
    if (spec.fail) {
      await csvRepo.recordFailure(created.id, spec.fail);
    } else {
      await csvRepo.recordImportResult(created.id, {
        totalRowCount: spec.total,
        importedRowCount: spec.imported,
        quarantinedRowCount: spec.quarantined,
        skippedRowCount: spec.skipped,
      });
    }
    importsCreated += 1;
  }
}
log('csv import history', { created: importsCreated });

console.log(
  JSON.stringify(
    {
      stage: 'complete',
      organizationId,
      notificationRules: ruleIdByType.size,
      reorderAlerts,
      expiryAlerts,
      conversations: conversationsCreated,
      messages: messagesCreated,
      csvImports: importsCreated,
      notificationDeliveries: deliveriesCreated,
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
    },
    null,
    2
  )
);
await client.end();
process.exit(0);
