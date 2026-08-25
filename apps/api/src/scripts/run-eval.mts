// Loads .env.local so this script runs straight from a fresh clone (see load-env.ts).
import '@retailos/config/auto';
/**
 * Runs the assistant's golden evaluation set against the LIVE model and the demo org's real data.
 * This is the missing button on the eval harness: the runner and cases have unit coverage against
 * a scripted provider, but injection resistance and routing accuracy are claims about a real
 * model, and only a real run turns them from claims into measurements.
 *
 * Context construction deliberately mirrors the assistant router line for line (the same db,
 * search repository, and recipe-cost resolver wiring), so a case passing here means the same
 * question passes through the real serving path — not a parallel harness that could drift.
 *
 * Usage (needs DATABASE_URL, GEMINI_API_KEY; ~3 model calls per case, so mind the free-tier
 * daily quota — a partial run stops with a clear per-case error rather than fabricating results):
 *   pnpm --filter @retailos/api eval
 */
import { createDb, users, memberships, SearchRepository, MenuItemRepository, RecipeRepository, StoreRepository, ProductRepository } from '@retailos/db';
import { createGeminiChatProvider, modelForTask } from '@retailos/ai';
import { runEvalSuite, GOLDEN_SET, type EvalRunDeps } from '@retailos/assistant';
import { permissionsForRole, type AuthContext } from '@retailos/authz';
import { resolveRecipeUnitCost, type MetricContext } from '@retailos/metrics';
import type { MarginMetricContext } from '@retailos/metrics';
import { eq } from 'drizzle-orm';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY is required — the whole point of this run is the live model.');
  process.exit(1);
}

const { db } = createDb(process.env.DATABASE_URL!);

const [demoUser] = await db
  .select({ userId: users.id, organizationId: memberships.organizationId })
  .from(users)
  .innerJoin(memberships, eq(memberships.userId, users.id))
  .where(eq(users.email, 'demo@vyapaar.test'));
if (!demoUser) {
  console.error('Demo user not found — run the demo seeds first.');
  process.exit(1);
}

const auth: AuthContext = {
  userId: demoUser.userId,
  organizationId: demoUser.organizationId,
  storeIds: 'ALL',
  role: 'OWNER',
  permissions: permissionsForRole('OWNER'),
};

const menuItemRepository = new MenuItemRepository(db, demoUser.organizationId);
const recipeRepository = new RecipeRepository(db, demoUser.organizationId);
const ctx: MarginMetricContext & { searchRepository: SearchRepository; geminiApiKey: string } = {
  db: db as MetricContext['db'],
  organizationId: demoUser.organizationId,
  storeIds: 'ALL',
  searchRepository: new SearchRepository(db, demoUser.organizationId),
  geminiApiKey: apiKey,
  resolveRecipeUnitCost: async (_ctx, menuItemId, currency) => {
    const menuItem = await menuItemRepository.findById(menuItemId);
    if (!menuItem) return 'unknown';
    return resolveRecipeUnitCost(db, demoUser.organizationId, recipeRepository, menuItem.recipeGroupId, currency);
  },
};

// The eval runs against the real seeded org's real stores, so it exercises the same store
// resolution the live assistant does rather than silently skipping it.
const accessibleStores = (await new StoreRepository(db, demoUser.organizationId).findAll()).map((store) => ({
  id: store.id,
  name: store.name,
}));

const accessibleProducts = await new ProductRepository(db, demoUser.organizationId).findAllWithDefaultVariant();

const deps: EvalRunDeps = {
  auth,
  accessibleProducts,
  ctx: ctx as unknown as MetricContext,
  accessibleStores,
  classifyModel: modelForTask('CLASSIFY'),
  planModel: modelForTask('PLAN'),
  narrateModel: modelForTask('NARRATE'),
};

const provider = createGeminiChatProvider(apiKey);
console.log(`Running ${GOLDEN_SET.length} golden cases against ${deps.classifyModel} / ${deps.planModel} / ${deps.narrateModel}…\n`);

const summary = await runEvalSuite(GOLDEN_SET, provider, deps);

for (const result of summary.results) {
  const mark = result.passed ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${result.caseId} — ${result.question}`);
  if (!result.passed) {
    for (const check of result.checks.filter((c) => !c.passed)) console.log(`      ✗ ${check.name}: ${check.detail}`);
  }
}

console.log('\n=== Summary ===');
console.log(`${summary.passed}/${summary.total} passed`);
for (const [category, tally] of Object.entries(summary.byCategory)) {
  console.log(`  ${category}: ${tally.passed}/${tally.total}`);
}
process.exit(summary.failed > 0 ? 1 : 0);
