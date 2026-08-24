import { CatalogCsvImportRepository, CategoryRepository, ProductRepository, RecipeRepository, RecipeCycleError, SupplierRepository, UnitRepository } from '@retailos/db';
import {
  detectCsvHeaders,
  generateId,
  parseProductCsvRows,
  parseSupplierCsvRows,
  parseRecipeCsvRows,
  type DetectedCsvHeaders,
  type ProductCsvColumnMapping,
  type SupplierCsvColumnMapping,
  type RecipeCsvColumnMapping,
} from '@retailos/domain';
import type { db as Db } from '../trpc/context';

export class CatalogCsvImportNotFoundError extends Error {
  constructor() {
    super('Catalog CSV import not found.');
    this.name = 'CatalogCsvImportNotFoundError';
  }
}

export class CatalogCsvImportWrongStatusError extends Error {
  constructor(expected: string, actual: string) {
    super(`Catalog CSV import must be '${expected}' for this action, but is '${actual}'.`);
    this.name = 'CatalogCsvImportWrongStatusError';
  }
}

/** Mirrors `csv-import.ts`'s `detectAndRecordHeaders` exactly — same header-detection function, a different repository/table underneath. */
export const detectAndRecordCatalogCsvHeaders = async (
  db: typeof Db,
  organizationId: string,
  importId: string,
  csvText: string
): Promise<DetectedCsvHeaders> => {
  const repository = new CatalogCsvImportRepository(db, organizationId);
  const importRow = await repository.findById(importId);
  if (!importRow) throw new CatalogCsvImportNotFoundError();

  const detected = detectCsvHeaders(csvText);
  await repository.recordDetectedHeaders(importId, detected);
  return detected;
};

export type CatalogCsvImportCommitResult = {
  totalRowCount: number;
  importedRowCount: number;
  skippedRowCount: number;
  /** Rows that parsed cleanly but were flagged as a likely duplicate of an existing catalog row — still imported (I9: never a silent skip), but worth surfacing in the result so the human knows to go check for a merge afterward. */
  possibleDuplicateCount: number;
};

/**
 * A top-level (no parent) category, resolved by case-insensitive exact name — reused if the org
 * already has one by that name, created if not. Never silently drops a category a CSV row named;
 * never guesses a parent category, since a flat CSV has no hierarchy information to guess from.
 *
 * Goes through `CategoryRepository`, never a raw query.
 *
 * The previous version did its own `db.select` / `db.insert` against `categories`, which has RLS
 * ENABLED and FORCED. A raw statement carries no tenant context, so Postgres rejected the insert
 * with `unrecognized configuration parameter "app.current_org_id"` — and it went unnoticed locally
 * because a superuser connection bypasses RLS entirely, while CI runs as the RLS-scoped
 * `retailos_app` role. Verified both directions with raw psql: the insert fails as `retailos_app`
 * without context and succeeds inside a transaction that sets it.
 *
 * The repository sets that context per transaction, which is exactly why every tenant-scoped write
 * in this codebase is supposed to go through one.
 */
const resolveOrCreateCategoryId = async (db: typeof Db, organizationId: string, name: string): Promise<string> => {
  const repository = new CategoryRepository(db, organizationId);
  const trimmed = name.trim();

  const existing = await repository.findAll();
  const match = existing.find((c) => c.name.trim().toLowerCase() === trimmed.toLowerCase());
  if (match) return match.id;

  const created = await repository.create({ id: generateId(), name: trimmed });
  return created.id;
};

/**
 * Parses every row per the human-confirmed mapping, resolves each row's unit code against the
 * real global `units` table (never a guessed/synthesized unit — I6), and calls
 * `ProductRepository.create` per row — never a raw insert, so the mandatory default-variant row
 * (`ProductRepository`'s own load-bearing invariant) is never bypassed. A row whose unit doesn't
 * resolve, or whose SKU collides with an existing product, becomes a skipped row with a real reason
 * — never a guess, never a silent partial write.
 */
export const commitProductCatalogCsvImport = async (
  db: typeof Db,
  organizationId: string,
  importId: string,
  csvText: string
): Promise<CatalogCsvImportCommitResult> => {
  const repository = new CatalogCsvImportRepository(db, organizationId);
  const importRow = await repository.findById(importId);
  if (!importRow) throw new CatalogCsvImportNotFoundError();
  if (importRow.importType !== 'PRODUCT') throw new CatalogCsvImportWrongStatusError('PRODUCT', importRow.importType);
  if (importRow.status !== 'MAPPED' && importRow.status !== 'IMPORTED') {
    throw new CatalogCsvImportWrongStatusError('MAPPED', importRow.status);
  }
  if (!importRow.detectedHeaders || !importRow.columnMapping) {
    throw new Error('Catalog CSV import is MAPPED but missing detectedHeaders/columnMapping.');
  }

  const detected = importRow.detectedHeaders as unknown as DetectedCsvHeaders;
  const mapping = importRow.columnMapping as unknown as ProductCsvColumnMapping;

  const productRepository = new ProductRepository(db, organizationId);
  const existingProducts = await productRepository.findAll();
  const existingNames = existingProducts.map((p) => p.name);
  const existingSkus = new Set(existingProducts.map((p) => p.sku));

  const unitRepository = new UnitRepository(db);
  const units = await unitRepository.findAll();
  const unitIdByCode = new Map(units.map((u) => [u.code, u.id]));

  let parsed;
  try {
    parsed = parseProductCsvRows(csvText, detected.headers, mapping, existingNames);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'CSV parsing failed.';
    await repository.recordFailure(importId, message);
    throw err;
  }

  let importedRowCount = 0;
  let skippedRowCount = parsed.issues.length;
  let possibleDuplicateCount = 0;
  const categoryIdByName = new Map<string, string>();

  for (const row of parsed.rows) {
    if (existingSkus.has(row.sku)) {
      skippedRowCount += 1;
      continue;
    }
    const baseUnitId = unitIdByCode.get(row.unitCode);
    if (!baseUnitId) {
      skippedRowCount += 1;
      continue;
    }

    let categoryId: string | undefined;
    if (row.categoryName) {
      const cached = categoryIdByName.get(row.categoryName.toLowerCase());
      categoryId = cached ?? (await resolveOrCreateCategoryId(db, organizationId, row.categoryName));
      categoryIdByName.set(row.categoryName.toLowerCase(), categoryId);
    }

    await productRepository.create({
      id: generateId(),
      sku: row.sku,
      name: row.name,
      baseUnitId,
      type: row.type,
      ...(categoryId !== undefined ? { categoryId } : {}),
    });
    existingSkus.add(row.sku);
    importedRowCount += 1;
    if (row.possibleDuplicateOf) possibleDuplicateCount += 1;
  }

  const result: CatalogCsvImportCommitResult = {
    totalRowCount: parsed.rows.length + parsed.issues.length,
    importedRowCount,
    skippedRowCount,
    possibleDuplicateCount,
  };
  await repository.recordImportResult(importId, { totalRowCount: result.totalRowCount, importedRowCount, skippedRowCount });
  return result;
};

/**
 * Same shape as `commitProductCatalogCsvImport` for suppliers — `SupplierRepository.create`'s
 * only genuinely required field is `name`; a duplicate-by-name row is still imported (I9: no
 * auto-merge), just flagged in `possibleDuplicateCount` for the human to review afterward.
 */
export const commitSupplierCatalogCsvImport = async (
  db: typeof Db,
  organizationId: string,
  importId: string,
  csvText: string
): Promise<CatalogCsvImportCommitResult> => {
  const repository = new CatalogCsvImportRepository(db, organizationId);
  const importRow = await repository.findById(importId);
  if (!importRow) throw new CatalogCsvImportNotFoundError();
  if (importRow.importType !== 'SUPPLIER') throw new CatalogCsvImportWrongStatusError('SUPPLIER', importRow.importType);
  if (importRow.status !== 'MAPPED' && importRow.status !== 'IMPORTED') {
    throw new CatalogCsvImportWrongStatusError('MAPPED', importRow.status);
  }
  if (!importRow.detectedHeaders || !importRow.columnMapping) {
    throw new Error('Catalog CSV import is MAPPED but missing detectedHeaders/columnMapping.');
  }

  const detected = importRow.detectedHeaders as unknown as DetectedCsvHeaders;
  const mapping = importRow.columnMapping as unknown as SupplierCsvColumnMapping;

  const supplierRepository = new SupplierRepository(db, organizationId);
  const existingSuppliers = await supplierRepository.findAll();
  const existingNames = existingSuppliers.map((s) => s.name);

  let parsed;
  try {
    parsed = parseSupplierCsvRows(csvText, detected.headers, mapping, existingNames);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'CSV parsing failed.';
    await repository.recordFailure(importId, message);
    throw err;
  }

  let importedRowCount = 0;
  let possibleDuplicateCount = 0;

  for (const row of parsed.rows) {
    await supplierRepository.create({
      id: generateId(),
      name: row.name,
      ...(row.paymentTerms !== null ? { paymentTerms: row.paymentTerms } : {}),
      ...(row.leadTimeDaysContracted !== null ? { leadTimeDaysContracted: row.leadTimeDaysContracted } : {}),
      ...(row.minOrderValue !== null ? { minOrderValue: row.minOrderValue } : {}),
    });
    importedRowCount += 1;
    if (row.possibleDuplicateOf) possibleDuplicateCount += 1;
  }

  const result: CatalogCsvImportCommitResult = {
    totalRowCount: parsed.rows.length + parsed.issues.length,
    importedRowCount,
    skippedRowCount: parsed.issues.length,
    possibleDuplicateCount,
  };
  await repository.recordImportResult(importId, { totalRowCount: result.totalRowCount, importedRowCount, skippedRowCount: result.skippedRowCount });
  return result;
};

export type RecipeCatalogCsvImportCommitResult = {
  /** A "row" here is a recipe GROUP, not a CSV line — matches the plan's own "how many recipes imported" framing better than a raw line count, since a recipe with 5 ingredients is one real recipe, not 5. */
  totalRowCount: number;
  importedRowCount: number;
  skippedRowCount: number;
  /** Every real reason a whole recipe group was skipped — an unresolvable ingredient, a bad row, or a cycle — surfaced by group name so a human can see exactly which recipes need a source-file fix, never silently dropped (I7). */
  skippedGroups: { recipeName: string; reason: string }[];
};

/**
 * Confirmed via `AskUserQuestion`: a recipe group with ANY unresolvable component (an ingredient
 * name that doesn't match a real product in this org, or a row-level parse issue within the group)
 * is skipped WHOLESALE — never imported with only its resolvable ingredients. A recipe missing an
 * ingredient looks complete and isn't; that's a worse failure mode than an honest "this recipe was
 * skipped, here's why" (I7). Product name resolution is EXACT, case-insensitive match only — no
 * fuzzy matching, since silently picking the "closest" product for a recipe component would
 * corrupt real cost data (matches this codebase's own recipes.create router validating every
 * component's real id before ever calling RecipeRepository.create).
 */
export const commitRecipeCatalogCsvImport = async (
  db: typeof Db,
  organizationId: string,
  importId: string,
  csvText: string
): Promise<RecipeCatalogCsvImportCommitResult> => {
  const repository = new CatalogCsvImportRepository(db, organizationId);
  const importRow = await repository.findById(importId);
  if (!importRow) throw new CatalogCsvImportNotFoundError();
  if (importRow.importType !== 'RECIPE') throw new CatalogCsvImportWrongStatusError('RECIPE', importRow.importType);
  if (importRow.status !== 'MAPPED' && importRow.status !== 'IMPORTED') {
    throw new CatalogCsvImportWrongStatusError('MAPPED', importRow.status);
  }
  if (!importRow.detectedHeaders || !importRow.columnMapping) {
    throw new Error('Catalog CSV import is MAPPED but missing detectedHeaders/columnMapping.');
  }

  const detected = importRow.detectedHeaders as unknown as DetectedCsvHeaders;
  const mapping = importRow.columnMapping as unknown as RecipeCsvColumnMapping;

  const productRepository = new ProductRepository(db, organizationId);
  const existingProducts = await productRepository.findAll();
  const productIdByLowerName = new Map(existingProducts.map((p) => [p.name.trim().toLowerCase(), p.id]));

  const unitRepository = new UnitRepository(db);
  const units = await unitRepository.findAll();
  const unitIdByCode = new Map(units.map((u) => [u.code, u.id]));

  let parsed;
  try {
    parsed = parseRecipeCsvRows(csvText, detected.headers, mapping);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'CSV parsing failed.';
    await repository.recordFailure(importId, message);
    throw err;
  }

  const recipeRepository = new RecipeRepository(db, organizationId);
  let importedRowCount = 0;
  let skippedRowCount = 0;
  const skippedGroups: { recipeName: string; reason: string }[] = [];

  for (const group of parsed.groups) {
    const yieldUnitId = unitIdByCode.get(group.yieldUnitCode);
    if (!yieldUnitId) {
      skippedRowCount += 1;
      skippedGroups.push({ recipeName: group.recipeName, reason: `unresolvable yield unit '${group.yieldUnitCode}'` });
      continue;
    }

    const resolvedComponents: { productId: string; quantity: string; unitId: string; wasteFactor?: string }[] = [];
    let unresolvedReason: string | null = null;

    for (const component of group.components) {
      const productId = productIdByLowerName.get(component.productName.trim().toLowerCase());
      if (!productId) {
        unresolvedReason = `ingredient '${component.productName}' does not match any existing product in this organization`;
        break;
      }
      const componentUnitId = unitIdByCode.get(component.unitCode);
      if (!componentUnitId) {
        unresolvedReason = `unresolvable unit '${component.unitCode}' for ingredient '${component.productName}'`;
        break;
      }
      resolvedComponents.push({
        productId,
        quantity: component.quantity,
        unitId: componentUnitId,
        ...(component.wasteFactor !== null ? { wasteFactor: component.wasteFactor } : {}),
      });
    }

    if (unresolvedReason) {
      skippedRowCount += 1;
      skippedGroups.push({ recipeName: group.recipeName, reason: unresolvedReason });
      continue;
    }

    try {
      await recipeRepository.create({
        id: generateId(),
        recipeGroupId: generateId(),
        name: group.recipeName,
        yieldQuantity: group.yieldQuantity,
        yieldUnitId,
        validFrom: new Date(),
        components: resolvedComponents.map((c) => ({ componentType: 'PRODUCT' as const, ...c })),
      });
      importedRowCount += 1;
    } catch (err) {
      skippedRowCount += 1;
      const reason = err instanceof RecipeCycleError ? err.message : err instanceof Error ? err.message : 'recipe creation failed';
      skippedGroups.push({ recipeName: group.recipeName, reason });
    }
  }

  // Every row-level parse issue (a component row that never made it into any group) also counts as
  // a real skipped unit of work, even though it has no group name to attach to.
  skippedRowCount += parsed.issues.length;
  for (const issue of parsed.issues) {
    skippedGroups.push({ recipeName: `(row ${issue.rowIndex})`, reason: issue.reason });
  }

  const result: RecipeCatalogCsvImportCommitResult = {
    totalRowCount: parsed.groups.length + parsed.issues.length,
    importedRowCount,
    skippedRowCount,
    skippedGroups,
  };
  await repository.recordImportResult(importId, { totalRowCount: result.totalRowCount, importedRowCount, skippedRowCount });
  return result;
};
