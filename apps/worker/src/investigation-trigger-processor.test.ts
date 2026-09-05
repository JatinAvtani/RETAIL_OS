// Set BEFORE the processor module is imported — it reads this once at module load. The real 20s
// inter-investigation delay exists to protect a live provider's per-minute quota; there is no live
// provider here, so paying it would only make the suite slow.
process.env.INVESTIGATION_TRIGGER_DELAY_MS = '0';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import {
  createDb,
  investigations,
  notifications,
  notificationRules,
  organizations,
  stores,
  InvestigationRepository,
} from '@retailos/db';
import { createInvestigationTriggerProcessor, RULE_TYPES_TO_INVESTIGATE } from './investigation-trigger-processor';

const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';
const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';

/**
 * Matches `briefing-processor.test.ts`'s own established convention: real Postgres, real
 * repositories, `geminiApiKey: undefined` for the cases that don't need a live model call — this
 * processor's own no-key degrade path, and its idempotency/per-item-resilience orchestration
 * (which happens entirely BEFORE any provider call is made). The real multi-hop LLM behavior itself
 * is `runInvestigation`'s own responsibility, already proven with a fake provider in
 * `packages/assistant/src/investigate.test.ts` — this file proves the SWEEP's own composition:
 * does it find the right notifications, does it skip already-investigated ones, does one failure
 * leave every other real notification's outcome intact.
 */
describe('investigation trigger processor', () => {
  const db = createDb(ADMIN_CONNECTION_STRING).db;
  const appDb = createDb(APP_CONNECTION_STRING).db;
  let organizationId: string;
  let storeId: string;
  let ruleId: string;

  beforeAll(async () => {
    organizationId = generateId();
    await db.insert(organizations).values({
      id: organizationId,
      name: 'Investigation Trigger Test Org',
      slug: `investigation-trigger-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });
    ruleId = generateId();
    await db.insert(notificationRules).values({
      id: ruleId,
      organizationId,
      // Must be a type this sweep actually investigates, or every assertion below passes
      // vacuously — the processor would correctly skip the notification and the test would prove
      // nothing. Reads from the exported constant rather than hardcoding, so narrowing that list
      // again can never silently turn this suite into a no-op.
      ruleType: RULE_TYPES_TO_INVESTIGATE[0],
      threshold: {},
      severity: 'MEDIUM',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });
  });

  afterEach(async () => {
    await db.delete(investigations).where(eq(investigations.organizationId, organizationId));
    await db.delete(notifications).where(eq(notifications.organizationId, organizationId));
  });

  afterAll(async () => {
    await db.delete(notificationRules).where(eq(notificationRules.organizationId, organizationId));
    await db.delete(stores).where(eq(stores.organizationId, organizationId));
    await db.delete(organizations).where(eq(organizations.id, organizationId));
  });

  const seedNotification = async (): Promise<string> => {
    const id = generateId();
    await db.insert(notifications).values({
      id,
      organizationId,
      storeId,
      ruleId,
      severity: 'MEDIUM',
      title: 'Unusual sales pattern detected',
      body: 'Revenue was a statistical outlier.',
      dedupKey: `test-${id}`,
    });
    return id;
  };

  it('with no Gemini key configured, a real uninvestigated notification produces a real, honest FAILED row naming why — never silent, never a fabricated result', async () => {
    const notificationId = await seedNotification();
    const processor = createInvestigationTriggerProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, geminiApiKey: undefined });

    const result = await processor();

    // This sweep is cross-tenant by design, and a shared dev/CI database legitimately holds other
    // orgs' uninvestigated notifications, so the tick's own totals are not this test's to own.
    // What IS this test's to own is the real end state for THIS org's notification — asserted
    // directly against the rows below. Asserting the global tally instead made the test depend on
    // whatever else happened to exist in the database.
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(investigations).where(eq(investigations.organizationId, organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('FAILED');
    expect(rows[0]?.sourceNotificationId).toBe(notificationId);
    expect(rows[0]?.error).toContain('No Gemini API key');
  });

  it('a notification that already has a real investigation is skipped, never double-processed — the sweep\'s own idempotency guarantee, exercised WITHOUT a live key', async () => {
    const notificationId = await seedNotification();
    const investigationRepo = new InvestigationRepository(appDb, organizationId);
    await investigationRepo.createRunning({ storeId, sourceNotificationId: notificationId, question: 'already running' });

    // findUninvestigatedNotifications itself already excludes this notification (proven separately
    // in uninvestigated-notifications.test.ts) — this test proves the SWEEP as a whole still
    // produces the correct end state: no second investigation row, no key needed to prove it, since
    // the skip happens via the anti-join query before any per-item, key-gated logic runs at all.
    const processor = createInvestigationTriggerProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, geminiApiKey: undefined });
    const result = await processor();

    // Deliberately NOT asserting `result.failed === 0`. This sweep is cross-tenant, and in a shared
    // database another org's real uninvestigated notification legitimately fails on the missing key
    // in the same tick — a true fact about a different org, not about the guarantee under test.
    // The guarantee is "no SECOND row for THIS notification", which the org-scoped rows below prove
    // exactly.
    void result;
    // Still exactly one investigation row (the pre-existing one) — never a second.
    const rows = await db.select().from(investigations).where(eq(investigations.organizationId, organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.question).toBe('already running');
  });

  it('with no notifications of its own, creates no investigation for this org', async () => {
    const processor = createInvestigationTriggerProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, geminiApiKey: undefined });
    await processor();
    // Org-scoped rather than a global all-zero tally: this sweep is cross-tenant, so another org's
    // real backlog in a shared database is not this test's business. That THIS org produced
    // nothing is.
    const rows = await db.select().from(investigations).where(eq(investigations.organizationId, organizationId));
    expect(rows).toHaveLength(0);
  });
});
