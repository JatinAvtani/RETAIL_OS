// Loads .env.local so this script runs straight from a fresh clone (see load-env.ts).
import '@retailos/config/auto';
/**
 * Seeds one assistant conversation whose ASSISTANT message carries a REAL grounding bundle,
 * computed by the real metric catalog through `executeMetric` — not a hand-written JSON blob.
 *
 * Exists because the assistant's live path depends on a Gemini call, and a quota-exhausted key
 * makes the citation/"how this was calculated" UI unverifiable end to end. This bypasses ONLY the
 * narration step (the model's job); every figure, period, freshness value and provenance row count
 * still comes from the same catalog execution a live answer would use, so what the UI renders is
 * genuinely real data rather than a fixture that merely looks like it.
 *
 * Usage: DATABASE_URL=... tsx src/scripts/seed-assistant-turn.mts <email>
 */
import { createDb, users, memberships, stores, ConversationRepository, MessageRepository } from '@retailos/db';
import { executeMetric } from '@retailos/metrics';
import { buildCitations } from '@retailos/assistant';
import { permissionsForRole } from '@retailos/authz';
import { eq } from 'drizzle-orm';

const email = process.argv[2];
if (!email) {
  console.error('Usage: tsx src/scripts/seed-assistant-turn.mts <email>');
  process.exit(1);
}

const { db } = createDb(process.env.DATABASE_URL!);

const [user] = await db.select().from(users).where(eq(users.email, email));
if (!user) {
  console.error(`No user found for ${email}.`);
  process.exit(1);
}

const [membership] = await db.select().from(memberships).where(eq(memberships.userId, user.id));
if (!membership) {
  console.error('That user has no organization membership.');
  process.exit(1);
}
const organizationId = membership.organizationId;

const storeRows = await db.select().from(stores).where(eq(stores.organizationId, organizationId));
const storeIds = storeRows.map((s) => s.id);
if (storeIds.length === 0) {
  console.error('That organization has no stores.');
  process.exit(1);
}

// Permissions come from the real role→permission mapping, never a hand-listed set — a guessed list
// silently under- or over-grants and would make this seed diverge from what a real caller can see.
const auth = {
  userId: user.id,
  organizationId,
  storeIds: 'ALL' as const,
  role: membership.role,
  permissions: permissionsForRole(membership.role),
};

const to = new Date();
const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
const ctx = { db, organizationId, storeIds };

const wanted = ['net_revenue', 'food_cost_percentage', 'contribution_margin_percentage'];
const metrics = [];
for (const metricId of wanted) {
  try {
    const result = await executeMetric(metricId, { storeId: storeIds[0], from, to }, auth as never, ctx as never);
    metrics.push(result);
    console.log(`  ${metricId} = ${result.value} (${result.provenance.map((p) => `${p.table}:${p.rowCount}`).join(', ')})`);
  } catch (error) {
    console.log(`  ${metricId} skipped: ${(error as Error).message}`);
  }
}

if (metrics.length === 0) {
  console.error('No metrics computed — nothing real to cite, so nothing is being written.');
  process.exit(1);
}

const bundle = { metrics, passages: [], entities: [] };

const conversationRepository = new ConversationRepository(db, organizationId);
const messageRepository = new MessageRepository(db, organizationId);

const question = 'How did the business do over the last 30 days?';
const { id: conversationId } = await conversationRepository.create({ userId: user.id, title: question });
await messageRepository.create({ conversationId, role: 'USER', content: question });

const known = metrics.filter((m) => m.value !== 'unknown');
// Same label/value phrasing as the router's own structured fallback — this seeded row renders in
// the identical chat surface, so raw metric ids here would read as debug output there.
const label = (metricId: string): string => {
  const words = metricId.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const display = (value: string, unit?: string): string => {
  const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return unit === 'PERCENTAGE' ? `${trimmed}%` : trimmed;
};
const content =
  known.length > 0
    ? `Here is what was found — ${known.map((m) => `${label(m.metricId)}: ${display(m.value, m.unit)}`).join(', ')}.`
    : 'No information was found to answer this question.';

await messageRepository.create({
  conversationId,
  role: 'ASSISTANT',
  content,
  groundingBundle: bundle,
  validationResult: { grounded: true },
});

console.log(JSON.stringify({ conversationId, metrics: metrics.length, citations: buildCitations(bundle).metrics.length }, null, 2));
process.exit(0);
