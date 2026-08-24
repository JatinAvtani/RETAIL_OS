import Papa from 'papaparse';
import type { RealUnitCode } from './product-detection.js';

/**
 * CSV import templates for products and suppliers — bulk catalog entry as an alternative
 * to earlier work/invoice-derived auto-detection, for a tenant that already has a product/
 * supplier list in a spreadsheet and doesn't want to wait for invoices to accumulate. Recipes are a
 * real, deliberately deferred follow-up (confirmed before building): a recipe CSV row references an
 * EXISTING product with no auto-create fallback in `recipes.create`, and is structurally
 * multi-row-per-entity (one recipe + N component rows) rather than one-row-per-entity like products/
 * suppliers — a genuinely different parsing shape, not scope to rush into this task.
 *
 * Pure, no I/O — mirrors `packages/domain/src/sales/csv-import.ts`'s exact shape
 * (`detectXHeaders`/`parseXRows`, row-level issues never a whole-batch failure, every field either
 * read verbatim or left unset — never guessed, I7). Header/sample-row detection itself is IDENTICAL
 * to the sales importer's `detectCsvHeaders` (same PapaParse preview mechanics, same BOM-stripping)
 * — callers reuse `detectCsvHeaders` from `sales/csv-import.js` directly (I2) rather than a second
 * copy re-exported here, which would collide with that same name at the package's top-level barrel.
 */

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

const REAL_UNIT_CODES = ['kg', 'g', 'l', 'ml', 'each', 'mg'] as const;

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Same token-overlap scorer `product-detection.ts`/`supplier-detection.ts`/`menu-item-match.ts`
 * already established for "how similar are these two free-text strings" (I2's own precedent already
 * treats a local copy per call site as acceptable here, matching those three) — used to flag a CSV
 * row that looks like it names an ALREADY-REAL product/supplier, so the human reviewing the preview
 * can decide whether it's a duplicate rather than the importer silently creating a second row.
 */
const similarityScore = (a: string, b: string): number => {
  const normalizedA = normalize(a);
  const normalizedB = normalize(b);
  if (normalizedA.length === 0 || normalizedB.length === 0) return 0;
  if (normalizedA === normalizedB) return 1;

  const tokensA = new Set(normalizedA.split(' '));
  const tokensB = new Set(normalizedB.split(' '));
  const shared = [...tokensA].filter((token) => tokensB.has(token)).length;
  const totalDistinct = new Set([...tokensA, ...tokensB]).size;
  const tokenScore = totalDistinct === 0 ? 0 : shared / totalDistinct;

  const substringBonus = normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA) ? 0.2 : 0;

  return Math.min(1, tokenScore + substringBonus);
};

/** A CSV row's name scoring at or above this against an existing row is flagged as a likely duplicate — never auto-merged or auto-skipped (I9: the human decides). */
const DUPLICATE_SIMILARITY_THRESHOLD = 0.7;

export type CatalogCsvRowIssue = { rowIndex: number; reason: string };

/**
 * A single-column CSV (a bare supplier-name list is a realistic real-world case, and a product
 * file with only its 4 required columns is plausible too) has no delimiter to auto-detect between
 * — PapaParse reports this as an `UndetectableDelimiter` "error" even though it correctly falls
 * back to a comma and parses every cell right. That is not a real parse failure and must not be
 * treated as one; every OTHER PapaParse error still throws.
 */
const throwOnRealParseErrors = (errors: readonly { code: string; message: string }[]): void => {
  const real = errors.filter((e) => e.code !== 'UndetectableDelimiter');
  if (real.length > 0) {
    throw new Error(`CSV could not be parsed: ${real[0]!.message}`);
  }
};

// ---------------------------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------------------------

export type ProductCsvColumnMapping = {
  sku: string;
  name: string;
  unit: string;
  type: string;
  /** Optional — a CSV with no category column leaves every imported product uncategorized, a real and honest state (I7), never guessed from the name. */
  category?: string;
};

export type ParsedProductCsvRow = {
  rowIndex: number;
  sku: string;
  name: string;
  /** A real unit CODE the CSV cell named verbatim — never resolved to a units.id here (this module has no DB access); the caller resolves code -> id and turns an unresolvable code into an issue. */
  unitCode: string;
  type: 'INGREDIENT' | 'SELLABLE' | 'BOTH';
  categoryName: string | null;
  /** Set when this row's name scores above threshold against another name already seen — either an existing catalog product (the caller passes those in) or an earlier row in this SAME file (a spreadsheet listing the same product twice). Never used to skip the row automatically. */
  possibleDuplicateOf: string | null;
};

export type ParsedProductCsvResult = {
  rows: ParsedProductCsvRow[];
  issues: CatalogCsvRowIssue[];
};

const PRODUCT_TYPES = ['INGREDIENT', 'SELLABLE', 'BOTH'] as const;

/**
 * `existingProductNames` — real names already in this org's catalog, passed in by the caller (this
 * module does no DB I/O) — is checked for near-duplicates in ADDITION to duplicates within the file
 * itself, so re-importing a mostly-already-onboarded list flags the overlap instead of silently
 * proposing 150 new rows for products that already exist.
 */
export const parseProductCsvRows = (
  rawText: string,
  headers: string[],
  mapping: ProductCsvColumnMapping,
  existingProductNames: string[]
): ParsedProductCsvResult => {
  const text = stripBom(rawText);
  const result = Papa.parse<string[]>(text, { skipEmptyLines: true });
  throwOnRealParseErrors(result.errors);
  const dataRows = result.data.slice(1);

  const columnIndex = (headerName: string): number => headers.indexOf(headerName);
  const skuIdx = columnIndex(mapping.sku);
  const nameIdx = columnIndex(mapping.name);
  const unitIdx = columnIndex(mapping.unit);
  const typeIdx = columnIndex(mapping.type);
  const categoryIdx = mapping.category !== undefined ? columnIndex(mapping.category) : -1;

  if ([skuIdx, nameIdx, unitIdx, typeIdx].some((idx) => idx === -1)) {
    throw new Error('column mapping references a header that does not exist in this file');
  }

  const rows: ParsedProductCsvRow[] = [];
  const issues: CatalogCsvRowIssue[] = [];
  const seenNames: string[] = [...existingProductNames];

  dataRows.forEach((cells, i) => {
    const rowIndex = i + 1;

    const sku = cells[skuIdx]?.trim();
    const name = cells[nameIdx]?.trim();
    const unitRaw = cells[unitIdx]?.trim().toLowerCase();
    const typeRaw = cells[typeIdx]?.trim().toUpperCase();

    if (!sku || !name || !unitRaw || !typeRaw) {
      issues.push({ rowIndex, reason: 'missing a required field' });
      return;
    }

    if (!(REAL_UNIT_CODES as readonly string[]).includes(unitRaw)) {
      issues.push({ rowIndex, reason: `unrecognized unit '${unitRaw}' — must be one of ${REAL_UNIT_CODES.join(', ')}` });
      return;
    }

    if (!(PRODUCT_TYPES as readonly string[]).includes(typeRaw)) {
      issues.push({ rowIndex, reason: `unrecognized type '${typeRaw}' — must be one of ${PRODUCT_TYPES.join(', ')}` });
      return;
    }

    const categoryRaw = categoryIdx !== -1 ? cells[categoryIdx]?.trim() : undefined;

    const duplicateMatch = seenNames.find((existing) => similarityScore(name, existing) >= DUPLICATE_SIMILARITY_THRESHOLD);

    rows.push({
      rowIndex,
      sku,
      name,
      unitCode: unitRaw as RealUnitCode,
      type: typeRaw as ParsedProductCsvRow['type'],
      categoryName: categoryRaw && categoryRaw.length > 0 ? categoryRaw : null,
      possibleDuplicateOf: duplicateMatch ?? null,
    });
    seenNames.push(name);
  });

  return { rows, issues };
};

// ---------------------------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------------------------

export type SupplierCsvColumnMapping = {
  name: string;
  /** Optional — matches `SupplierRepository.create`'s own optional fields exactly. */
  paymentTerms?: string;
  leadTimeDaysContracted?: string;
  minOrderValue?: string;
};

export type ParsedSupplierCsvRow = {
  rowIndex: number;
  name: string;
  paymentTerms: string | null;
  leadTimeDaysContracted: number | null;
  minOrderValue: string | null;
  possibleDuplicateOf: string | null;
};

export type ParsedSupplierCsvResult = {
  rows: ParsedSupplierCsvRow[];
  issues: CatalogCsvRowIssue[];
};

export const parseSupplierCsvRows = (
  rawText: string,
  headers: string[],
  mapping: SupplierCsvColumnMapping,
  existingSupplierNames: string[]
): ParsedSupplierCsvResult => {
  const text = stripBom(rawText);
  const result = Papa.parse<string[]>(text, { skipEmptyLines: true });
  throwOnRealParseErrors(result.errors);
  const dataRows = result.data.slice(1);

  const columnIndex = (headerName: string): number => headers.indexOf(headerName);
  const nameIdx = columnIndex(mapping.name);
  const paymentTermsIdx = mapping.paymentTerms !== undefined ? columnIndex(mapping.paymentTerms) : -1;
  const leadTimeIdx = mapping.leadTimeDaysContracted !== undefined ? columnIndex(mapping.leadTimeDaysContracted) : -1;
  const minOrderIdx = mapping.minOrderValue !== undefined ? columnIndex(mapping.minOrderValue) : -1;

  if (nameIdx === -1) {
    throw new Error('column mapping references a header that does not exist in this file');
  }

  const rows: ParsedSupplierCsvRow[] = [];
  const issues: CatalogCsvRowIssue[] = [];
  const seenNames: string[] = [...existingSupplierNames];

  dataRows.forEach((cells, i) => {
    const rowIndex = i + 1;

    const name = cells[nameIdx]?.trim();
    if (!name) {
      issues.push({ rowIndex, reason: 'missing a required field' });
      return;
    }

    let leadTimeDaysContracted: number | null = null;
    if (leadTimeIdx !== -1) {
      const raw = cells[leadTimeIdx]?.trim();
      if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isNaN(parsed) || parsed < 0) {
          issues.push({ rowIndex, reason: `unparseable lead time '${raw}'` });
          return;
        }
        leadTimeDaysContracted = parsed;
      }
    }

    let minOrderValue: string | null = null;
    if (minOrderIdx !== -1) {
      const raw = cells[minOrderIdx]?.trim().replace(/[$€£,]/g, '');
      if (raw) {
        const parsed = Number.parseFloat(raw);
        if (Number.isNaN(parsed) || parsed < 0) {
          issues.push({ rowIndex, reason: `unparseable minimum order value '${cells[minOrderIdx]}'` });
          return;
        }
        minOrderValue = parsed.toFixed(4);
      }
    }

    const paymentTermsRaw = paymentTermsIdx !== -1 ? cells[paymentTermsIdx]?.trim() : undefined;

    const duplicateMatch = seenNames.find((existing) => similarityScore(name, existing) >= DUPLICATE_SIMILARITY_THRESHOLD);

    rows.push({
      rowIndex,
      name,
      paymentTerms: paymentTermsRaw && paymentTermsRaw.length > 0 ? paymentTermsRaw : null,
      leadTimeDaysContracted,
      minOrderValue,
      possibleDuplicateOf: duplicateMatch ?? null,
    });
    seenNames.push(name);
  });

  return { rows, issues };
};

// ---------------------------------------------------------------------------------------------
// Recipes — the deferred follow-up, built once products+suppliers import shipped
// ---------------------------------------------------------------------------------------------

/**
 * LONG format (confirmed via `AskUserQuestion` over a wide fixed-ingredient-column layout): one
 * row per COMPONENT, with the recipe's own name/yield/yieldUnit columns repeated on every row that
 * belongs to it — redundant but easy to author from a spreadsheet and easy to preview row-by-row,
 * matching how a real bakery bill-of-materials export looks. Rows are grouped into one recipe by
 * (recipeName, yieldQuantity, yieldUnit) — the same three values repeated identically across every
 * row of the same recipe; a row with different values under the SAME name starts a genuinely
 * different, second recipe rather than being silently merged (I7 — never guess which recipe a
 * mismatched row belongs to).
 */
export type RecipeCsvColumnMapping = {
  recipeName: string;
  yieldQuantity: string;
  yieldUnit: string;
  componentProductName: string;
  componentQuantity: string;
  componentUnit: string;
  /** Optional — matches `RecipeComponentInput.wasteFactor`'s own optional default of 1.0000. */
  wasteFactor?: string;
};

export type ParsedRecipeComponentRow = {
  rowIndex: number;
  productName: string;
  quantity: string;
  unitCode: string;
  wasteFactor: string | null;
};

export type ParsedRecipeCsvGroup = {
  recipeName: string;
  yieldQuantity: string;
  yieldUnitCode: string;
  components: ParsedRecipeComponentRow[];
};

export type ParsedRecipeCsvResult = {
  /** One entry per distinct (recipeName, yieldQuantity, yieldUnit) group — the caller resolves
   *  each component's productName/unitCode against the real catalog and calls RecipeRepository.create
   *  once per group, never per row. */
  groups: ParsedRecipeCsvGroup[];
  issues: CatalogCsvRowIssue[];
};

/**
 * Parses every row into its recipe group. A row missing any required cell, or naming an
 * unrecognized unit for either the recipe's own yield or a component, becomes a row-level issue —
 * the OWNING GROUP is not discarded just because one of its rows had a problem; the caller decides
 * later (once all groups are known) whether a group with any row-level issue should still attempt
 * to import its otherwise-clean rows or be skipped wholesale — this function only parses, it never
 * resolves a product name to a real id (no DB access here).
 */
export const parseRecipeCsvRows = (
  rawText: string,
  headers: string[],
  mapping: RecipeCsvColumnMapping
): ParsedRecipeCsvResult => {
  const text = stripBom(rawText);
  const result = Papa.parse<string[]>(text, { skipEmptyLines: true });
  throwOnRealParseErrors(result.errors);
  const dataRows = result.data.slice(1);

  const columnIndex = (headerName: string): number => headers.indexOf(headerName);
  const recipeNameIdx = columnIndex(mapping.recipeName);
  const yieldQuantityIdx = columnIndex(mapping.yieldQuantity);
  const yieldUnitIdx = columnIndex(mapping.yieldUnit);
  const componentProductNameIdx = columnIndex(mapping.componentProductName);
  const componentQuantityIdx = columnIndex(mapping.componentQuantity);
  const componentUnitIdx = columnIndex(mapping.componentUnit);
  const wasteFactorIdx = mapping.wasteFactor !== undefined ? columnIndex(mapping.wasteFactor) : -1;

  if (
    [recipeNameIdx, yieldQuantityIdx, yieldUnitIdx, componentProductNameIdx, componentQuantityIdx, componentUnitIdx].some((idx) => idx === -1)
  ) {
    throw new Error('column mapping references a header that does not exist in this file');
  }

  const issues: CatalogCsvRowIssue[] = [];
  // Keyed by "recipeName|yieldQuantity|yieldUnit" — an exact-string group key, never fuzzy-matched,
  // since two rows must repeat IDENTICAL recipe-level values to belong to the same recipe (I7).
  const groupsByKey = new Map<string, ParsedRecipeCsvGroup>();
  const groupOrder: string[] = [];

  dataRows.forEach((cells, i) => {
    const rowIndex = i + 1;

    const recipeName = cells[recipeNameIdx]?.trim();
    const yieldQuantityRaw = cells[yieldQuantityIdx]?.trim();
    const yieldUnitRaw = cells[yieldUnitIdx]?.trim().toLowerCase();
    const productName = cells[componentProductNameIdx]?.trim();
    const componentQuantityRaw = cells[componentQuantityIdx]?.trim();
    const componentUnitRaw = cells[componentUnitIdx]?.trim().toLowerCase();

    if (!recipeName || !yieldQuantityRaw || !yieldUnitRaw || !productName || !componentQuantityRaw || !componentUnitRaw) {
      issues.push({ rowIndex, reason: 'missing a required field' });
      return;
    }

    const yieldQuantity = Number.parseFloat(yieldQuantityRaw);
    if (Number.isNaN(yieldQuantity) || yieldQuantity <= 0) {
      issues.push({ rowIndex, reason: `unparseable or non-positive yield quantity '${yieldQuantityRaw}'` });
      return;
    }
    if (!(REAL_UNIT_CODES as readonly string[]).includes(yieldUnitRaw)) {
      issues.push({ rowIndex, reason: `unrecognized yield unit '${yieldUnitRaw}' — must be one of ${REAL_UNIT_CODES.join(', ')}` });
      return;
    }

    const componentQuantity = Number.parseFloat(componentQuantityRaw);
    if (Number.isNaN(componentQuantity) || componentQuantity <= 0) {
      issues.push({ rowIndex, reason: `unparseable or non-positive component quantity '${componentQuantityRaw}'` });
      return;
    }
    if (!(REAL_UNIT_CODES as readonly string[]).includes(componentUnitRaw)) {
      issues.push({ rowIndex, reason: `unrecognized component unit '${componentUnitRaw}' — must be one of ${REAL_UNIT_CODES.join(', ')}` });
      return;
    }

    let wasteFactor: string | null = null;
    if (wasteFactorIdx !== -1) {
      const raw = cells[wasteFactorIdx]?.trim();
      if (raw) {
        const parsed = Number.parseFloat(raw);
        if (Number.isNaN(parsed) || parsed < 1) {
          issues.push({ rowIndex, reason: `unparseable or invalid waste factor '${raw}' — must be >= 1` });
          return;
        }
        wasteFactor = parsed.toFixed(4);
      }
    }

    const groupKey = `${recipeName}|${yieldQuantityRaw}|${yieldUnitRaw}`;
    let group = groupsByKey.get(groupKey);
    if (!group) {
      group = { recipeName, yieldQuantity: yieldQuantity.toFixed(6), yieldUnitCode: yieldUnitRaw, components: [] };
      groupsByKey.set(groupKey, group);
      groupOrder.push(groupKey);
    }
    group.components.push({
      rowIndex,
      productName,
      quantity: componentQuantity.toFixed(6),
      unitCode: componentUnitRaw,
      wasteFactor,
    });
  });

  return { groups: groupOrder.map((key) => groupsByKey.get(key)!), issues };
};
