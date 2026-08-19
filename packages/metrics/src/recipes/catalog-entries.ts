import { z } from 'zod';
import { MenuItemRepository } from '@retailos/db';
import { defineMetric, type MetricContext, type MetricResult } from '../catalog/index.js';

/**
 * Operational health metric for recipes. Genuinely new: `menuItems.
 * recipeGroupId` is `NOT NULL` with deliberately no FK, so "no recipe" can never
 * mean `recipeGroupId IS NULL` — it means no `recipes` row with that `recipeGroupId` is currently
 * valid. `MenuItemRepository.findWithoutValidRecipe` (built for this task) does the real
 * `NOT EXISTS` check against `recipes`' effective-dating columns.
 */

const orgParams = z.object({});
type OrgParams = z.infer<typeof orgParams>;

export const menuItemsWithoutRecipeMetric = defineMetric<OrgParams>({
  id: 'menu_items_without_recipe',
  description: 'Count of menu items with no currently valid recipe — invalidates margin for these items.',
  parameters: orgParams,
  unit: 'COUNT',
  requiredPermission: 'inventory:read',
  sources: ['menu_items', 'recipes'],
  async execute(_params, ctx: MetricContext): Promise<MetricResult> {
    const menuItemRepository = new MenuItemRepository(ctx.db, ctx.organizationId);
    const rows = await menuItemRepository.findWithoutValidRecipe();
    const now = new Date();
    return {
      metricId: 'menu_items_without_recipe',
      value: String(rows.length),
      unit: 'COUNT',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'menu_items', rowCount: rows.length }],
    };
  },
});
