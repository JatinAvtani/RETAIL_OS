import { eq } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import {
  StoreRepository,
  PosConnectionRepository,
  CsvImportRepository,
  DocumentRepository,
  SupplierProductRepository,
  ProductRepository,
  SupplierRepository,
  RecipeRepository,
  ParLevelRepository,
  MenuItemRepository,
  DashboardRepository,
  OnboardingRepository,
  PosItemRepository,
  recipeComponents,
} from '@retailos/db';
import {
  detectProductCandidates,
  detectSupplierCandidates,
  computeOnboardingHealth,
  TOP_N_MENU_ITEMS_FOR_RECIPE_COVERAGE,
  type UnmappedInvoiceLine,
  type UnmappedSupplierMention,
  type OnboardingHealth,
} from '@retailos/domain';
import type { db as Db } from '../trpc/context';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** The recent window "trailing sales volume" is measured over — matches PosItemRepository.findUnmappedRankedByVolume's own reasoning (recent activity, not all-time) without needing an explicit param this task's real callers don't supply. */
const TRAILING_SALES_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type ExtractedLine = {
  sku?: { value: string | null };
  description?: { value: string | null };
  quantity?: { value: string | null };
  unit?: { value: string | null };
  unitPrice?: { value: string | null };
};

/** Runs real detectProductCandidates against one store's current unmapped invoice lines — same logic productDetectionRouter.detectProducts already runs per store, reused here (I2) rather than reimplemented, since this needs the SAME "still detectable right now" count that UI already computes. */
const detectProductCandidateCountForStore = async (
  db: typeof Db,
  organizationId: string,
  storeId: string
): Promise<number> => {
  const documentRepository = new DocumentRepository(db, organizationId);
  const supplierRepository = new SupplierRepository(db, organizationId);
  const supplierProductRepository = new SupplierProductRepository(db, organizationId);

  const extractions = await documentRepository.findApprovedExtractionsForStore(storeId);
  const confirmedMappings = await supplierProductRepository.findAll();
  const confirmedKeys = new Set(confirmedMappings.filter((m) => m.isConfirmed).map((m) => `${m.supplierId}:${m.supplierSku}`));

  const supplierIdByName = new Map<string, string | null>();
  const resolveSupplierId = async (supplierName: string | null): Promise<string | null> => {
    if (!supplierName) return null;
    if (supplierIdByName.has(supplierName)) return supplierIdByName.get(supplierName)!;
    const supplier = await supplierRepository.findByExactName(supplierName);
    supplierIdByName.set(supplierName, supplier?.id ?? null);
    return supplier?.id ?? null;
  };

  const unmappedLines: UnmappedInvoiceLine[] = [];
  for (const extraction of extractions) {
    const fields = extraction.fields as { supplier?: { value: string | null } } | null;
    const supplierName = fields?.supplier?.value ?? null;
    const supplierId = await resolveSupplierId(supplierName);

    const lines = (extraction.lines as ExtractedLine[] | null) ?? [];
    lines.forEach((line, lineIndex) => {
      const description = line.description?.value?.trim();
      if (!description) return;
      const sku = line.sku?.value?.trim() || null;
      if (sku && supplierId && confirmedKeys.has(`${supplierId}:${sku}`)) return;
      unmappedLines.push({
        documentId: extraction.documentId,
        lineIndex,
        supplierSku: sku,
        description,
        quantity: line.quantity?.value ?? null,
        unit: line.unit?.value ?? null,
        unitPrice: line.unitPrice?.value ?? null,
      });
    });
  }

  return detectProductCandidates(unmappedLines).length;
};

/** Same shape as `detectProductCandidateCountForStore`, mirroring `productDetectionRouter.detectSuppliers`'s real logic. */
const detectSupplierCandidateCountForStore = async (db: typeof Db, organizationId: string, storeId: string): Promise<number> => {
  const documentRepository = new DocumentRepository(db, organizationId);
  const supplierRepository = new SupplierRepository(db, organizationId);

  const extractions = await documentRepository.findApprovedExtractionsForStore(storeId);
  const existingSupplierNames = new Set<string>();
  const newSupplierNames = new Set<string>();
  const mentions: UnmappedSupplierMention[] = [];

  for (const extraction of extractions) {
    const fields = extraction.fields as { supplier?: { value: string | null } } | null;
    const supplierName = fields?.supplier?.value?.trim();
    if (!supplierName) continue;
    if (existingSupplierNames.has(supplierName)) continue;
    if (!newSupplierNames.has(supplierName)) {
      const existing = await supplierRepository.findByExactName(supplierName);
      if (existing) {
        existingSupplierNames.add(supplierName);
        continue;
      }
      newSupplierNames.add(supplierName);
    }
    mentions.push({ documentId: extraction.documentId, supplierName });
  }

  return detectSupplierCandidates(mentions).length;
};

/**
 * Walks `recipe_components` recursively (PRODUCT leaves collected, RECIPE components followed to
 * their own currently-valid version) to collect every real product id a menu item's recipe
 * ultimately consumes — deliberately NOT `packages/domain`'s `explodeRecipe`, which does real
 * unit-scaled quantity math this coverage check doesn't need; only the SET of leaf product ids
 * matters for "does every ingredient have a par level," never a quantity. Depth-limited the same
 * way `explodeRecipe` is, defending against an undetected cycle reaching this far.
 */
const collectLeafProductIds = async (
  db: typeof Db,
  organizationId: string,
  recipeRepository: InstanceType<typeof RecipeRepository>,
  recipeGroupId: string,
  asOf: Date,
  depth = 0,
  seen = new Set<string>()
): Promise<Set<string>> => {
  if (depth > 10 || seen.has(recipeGroupId)) return new Set();
  seen.add(recipeGroupId);

  const version = await recipeRepository.findVersionAsOf(recipeGroupId, asOf);
  if (!version) return new Set();

  const components = await db
    .select()
    .from(recipeComponents)
    .where(eq(recipeComponents.recipeId, version.id));

  const productIds = new Set<string>();
  for (const component of components) {
    if (component.componentType === 'PRODUCT' && component.productId) {
      productIds.add(component.productId);
    } else if (component.componentType === 'RECIPE' && component.subRecipeGroupId) {
      const subIds = await collectLeafProductIds(db, organizationId, recipeRepository, component.subRecipeGroupId, asOf, depth + 1, seen);
      for (const id of subIds) productIds.add(id);
    }
  }
  return productIds;
};

/**
 * The real orchestrator behind `onboarding.getHealth` — gathers every input `computeOnboardingHealth`
 * (packages/domain) needs from real tables, across every store in the org, then hands the composed
 * numbers to that pure function. This file does the I/O; health-score.ts does the scoring — the
 * same "pure compute, impure gather" split every other cross-cutting metric in this codebase uses.
 */
export const computeRealOnboardingHealth = async (db: typeof Db, organizationId: string): Promise<OnboardingHealth> => {
  const storeRepository = new StoreRepository(db, organizationId);
  const stores = await storeRepository.findAll();
  const storeCreated = stores.length > 0;

  const posConnectionRepository = new PosConnectionRepository(db, organizationId);
  const posConnections = await posConnectionRepository.findAllForOrganization();
  const hasConnectedPos = posConnections.some((c) => c.status === 'CONNECTED');

  const csvImportRepository = new CsvImportRepository(db, organizationId);
  const csvImports = await csvImportRepository.findAllForOrganization();
  const hasImportedSalesCsv = csvImports.some((i) => i.status === 'IMPORTED');

  const salesConnected = hasConnectedPos || hasImportedSalesCsv;

  const documentRepository = new DocumentRepository(db, organizationId);
  const invoicesUploadedAtLeast30Days = await documentRepository.hasApprovedInvoiceCreatedBefore(new Date(Date.now() - THIRTY_DAYS_MS));

  // Live re-detect ratio (confirmed via AskUserQuestion) — aggregated across every store, since
  // detection itself is per-store but the health score is an org-wide view.
  let totalDetectableProducts = 0;
  let totalDetectableSuppliers = 0;
  for (const store of stores) {
    totalDetectableProducts += await detectProductCandidateCountForStore(db, organizationId, store.id);
    totalDetectableSuppliers += await detectSupplierCandidateCountForStore(db, organizationId, store.id);
  }
  const productRepository = new ProductRepository(db, organizationId);
  const supplierRepository = new SupplierRepository(db, organizationId);
  const confirmedProductCount = (await productRepository.findAll()).length;
  const confirmedSupplierCount = (await supplierRepository.findAll()).length;
  const productsConfirmedRatio =
    confirmedProductCount + totalDetectableProducts === 0 ? null : confirmedProductCount / (confirmedProductCount + totalDetectableProducts);
  const suppliersConfirmedRatio =
    confirmedSupplierCount + totalDetectableSuppliers === 0 ? null : confirmedSupplierCount / (confirmedSupplierCount + totalDetectableSuppliers);

  // POS items mapped, by trailing sales REVENUE — org-wide, summed across every store's own
  // mapped-vs-total revenue (a raw item-count ratio would over-weight low-volume clutter items,
  // the exact gap the plan's own "top 20 covers ~80% of revenue" reasoning exists to avoid).
  const dashboardRepository = new DashboardRepository(db, organizationId);
  const trailingFrom = new Date(Date.now() - TRAILING_SALES_WINDOW_MS);
  const trailingTo = new Date();
  let mappedRevenue = new Decimal(0);
  let totalRevenue = new Decimal(0);
  const topItemsByStore: Array<{ menuItemId: string; quantitySold: Decimal }> = [];
  for (const store of stores) {
    const lines = await dashboardRepository.findSoldMappedItemLines(store.id, trailingFrom, trailingTo);
    for (const line of lines) {
      const revenue = new Decimal(line.revenue);
      mappedRevenue = mappedRevenue.plus(revenue);
      totalRevenue = totalRevenue.plus(revenue);
      topItemsByStore.push({ menuItemId: line.menuItemId, quantitySold: new Decimal(line.quantitySold) });
    }
  }
  // Unmapped revenue, org-wide via the same ranked-by-volume query the mapping UI already uses.
  const posItemRepository = new PosItemRepository(db, organizationId);
  const unmappedRanked = await posItemRepository.findUnmappedRankedByVolume();
  for (const item of unmappedRanked) {
    totalRevenue = totalRevenue.plus(new Decimal(item.totalRevenue));
  }
  const posItemsMappedRatioByVolume = totalRevenue.isZero() ? null : mappedRevenue.dividedBy(totalRevenue).toNumber();

  // Top-N menu items org-wide by trailing quantity sold, aggregated across stores (the same menu
  // item can sell at multiple stores; its quantities are summed, not treated as separate entries).
  const quantityByMenuItem = new Map<string, Decimal>();
  for (const { menuItemId, quantitySold } of topItemsByStore) {
    const running = quantityByMenuItem.get(menuItemId) ?? new Decimal(0);
    quantityByMenuItem.set(menuItemId, running.plus(quantitySold));
  }
  const topMenuItemIds = [...quantityByMenuItem.entries()]
    .sort((a, b) => b[1].comparedTo(a[1]))
    .slice(0, TOP_N_MENU_ITEMS_FOR_RECIPE_COVERAGE)
    .map(([menuItemId]) => menuItemId);

  const menuItemRepository = new MenuItemRepository(db, organizationId);
  const recipeRepository = new RecipeRepository(db, organizationId);
  const now = new Date();

  let withRecipe = 0;
  let fullyCovered = 0;
  let recipeCoveredMenuItemCount = 0;

  if (topMenuItemIds.length > 0) {
    const withoutValidRecipe = await menuItemRepository.findWithoutValidRecipe(now);
    const withoutRecipeIds = new Set(withoutValidRecipe.map((m) => m.id));

    const allTopMenuItems = await Promise.all(topMenuItemIds.map((id) => menuItemRepository.findById(id)));

    for (let i = 0; i < topMenuItemIds.length; i++) {
      const menuItemId = topMenuItemIds[i]!;
      const menuItem = allTopMenuItems[i];
      if (!menuItem || withoutRecipeIds.has(menuItemId)) continue; // no valid recipe — not counted toward recipesCreated, and excluded from par-level coverage (nothing to explode).
      withRecipe += 1;
      recipeCoveredMenuItemCount += 1;

      const leafProductIds = await collectLeafProductIds(db, organizationId, recipeRepository, menuItem.recipeGroupId, now);
      if (leafProductIds.size === 0) continue; // a recipe with zero real product components has nothing to check par levels against — not counted either way.

      let allCovered = true;
      for (const store of stores) {
        const parLevelRepository = new ParLevelRepository(db, organizationId);
        const configured = await parLevelRepository.findAllForStore(store.id);
        const configuredProductIds = new Set(configured.map((p) => p.productId));
        for (const productId of leafProductIds) {
          if (!configuredProductIds.has(productId)) {
            allCovered = false;
            break;
          }
        }
        if (!allCovered) break;
      }
      if (allCovered) fullyCovered += 1;
    }
  }

  const onboardingRepository = new OnboardingRepository(db, organizationId);
  const existingProgress = await onboardingRepository.findExistingOrNull();
  const onboardingProgressUpdatedAt = existingProgress?.updatedAt ?? null;

  return computeOnboardingHealth({
    storeCreated,
    salesConnected,
    invoicesUploadedAtLeast30Days,
    productsConfirmedRatio,
    suppliersConfirmedRatio,
    posItemsMappedRatioByVolume,
    recipesCreated: { withRecipe, topMenuItemCount: topMenuItemIds.length },
    parLevelsSet: { fullyCovered, recipeCoveredMenuItemCount },
    onboardingProgressUpdatedAt,
    now,
  });
};
