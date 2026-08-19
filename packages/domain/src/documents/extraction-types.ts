/**
 * The real, canonical shape `document_extractions.fields`/`.lines` stores as jsonb — matching
 * `@retailos/ai`'s own `ExtractedField`/`ExtractedFields`/`ExtractedLine` (`extraction-provider.ts`)
 * exactly, field for field, declared locally here rather than imported since `packages/domain` has
 * zero `@retailos/*` dependencies (the base layer everything else builds on). `semantic-search.ts`'s
 * pre-existing `ExtractedFieldValue`/`ExtractedDocumentFields`/`ExtractedDocumentLine` are a
 * NARROWER, older local subset (built for the document-embedding need, before this file existed) — kept
 * as-is rather than merged, since widening them now would be an unrelated, unasked-for refactor of
 * already-shipped code; `chunking.ts` uses this file's fuller shape instead, since chunk text needs
 * every real extracted field (quantity, unit, price), not just description/supplier/total.
 */
export type ExtractedField = {
  value: string | null;
  confidence: number | null;
};

export type ExtractedFields = {
  supplier: ExtractedField;
  documentNumber: ExtractedField;
  documentDate: ExtractedField;
  currency: ExtractedField;
  subtotal: ExtractedField;
  tax: ExtractedField;
  discount: ExtractedField;
  total: ExtractedField;
};

export type ExtractedLine = {
  sku: ExtractedField;
  description: ExtractedField;
  quantity: ExtractedField;
  unit: ExtractedField;
  unitPrice: ExtractedField;
  lineTotal: ExtractedField;
};
