import type { Job } from 'bullmq';
import {
  aggregateFactTablesForDay,
  createDb,
  MenuItemRepository,
  OrganizationRepository,
  RecipeRepository,
  resolveYesterdayLocalDate,
} from '@retailos/db';
import { resolveRecipeUnitCost } from '@retailos/metrics';
import type { CurrencyCode, StoreTimezone } from '@retailos/domain';
import type { FactAggregationJobData } from '@retailos/queue';

/**
 * 009-01 — the real worker-side handler for the daily fact-aggregation job. Resolves the store's
 * own "yesterday" (its local calendar date, not UTC's), then delegates every real aggregation step
 * to `aggregateFactTablesForDay` (`packages/db`), which has zero BullMQ/Redis awareness of its own
 * — matching `createExtractionProcessor`'s existing "processor is a thin adapter, the real logic
 * lives in a plain function" shape.
 *
 * `resolveRecipeUnitCost` (`@retailos/metrics`, 009-01) is adapted here from its real
 * `(db, organizationId, recipeRepository, recipeGroupId, currency) => Money | 'unknown'` shape into
 * the narrower `RecipeUnitCostLookup` (`menuItemId => {amount} | 'unknown'`) that
 * `aggregateFactTablesForDay` actually takes — `packages/db` cannot import `@retailos/metrics`
 * directly (metrics reads FROM db, never the reverse), so this adaptation can only happen here, at
 * the one layer allowed to depend on both.
 */
export const createFactAggregationProcessor = (config: { databaseUrl: string }) => {
  const { db } = createDb(config.databaseUrl);

  return async (job: Job<FactAggregationJobData>): Promise<void> => {
    const { organizationId, storeId, storeTimezone } = job.data;

    const organizationRepository = new OrganizationRepository(db, organizationId);
    const organization = await organizationRepository.findMine();
    if (!organization) {
      // The org was deleted after this job was scheduled — nothing to aggregate for it anymore.
      // BullMQ's own scheduler will keep firing until the job is explicitly removed; a missing org
      // is a signal to skip this run quietly, not to fail/retry into a permanent error state.
      return;
    }
    const currency = organization.baseCurrency as CurrencyCode;

    const menuItemRepository = new MenuItemRepository(db, organizationId);
    const recipeRepository = new RecipeRepository(db, organizationId);
    const menuItemCache = new Map<string, string | null>();

    const resolveUnitCost = async (menuItemId: string): Promise<{ amount: string } | 'unknown'> => {
      let recipeGroupId = menuItemCache.get(menuItemId);
      if (recipeGroupId === undefined) {
        const menuItem = await menuItemRepository.findById(menuItemId);
        recipeGroupId = menuItem?.recipeGroupId ?? null;
        menuItemCache.set(menuItemId, recipeGroupId);
      }
      if (!recipeGroupId) return 'unknown';

      const cost = await resolveRecipeUnitCost(db, organizationId, recipeRepository, recipeGroupId, currency);
      return cost === 'unknown' ? 'unknown' : { amount: cost.amount.toString() };
    };

    const localDate = resolveYesterdayLocalDate(storeTimezone as StoreTimezone);
    await aggregateFactTablesForDay(db, organizationId, storeId, storeTimezone as StoreTimezone, localDate, resolveUnitCost);
  };
};
