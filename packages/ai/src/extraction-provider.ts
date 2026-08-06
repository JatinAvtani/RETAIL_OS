/**
 * 007-05 (plan.md Phase 2): the `ExtractionProvider` interface, matching the shape EPIC-002's
 * extraction spike validated (`spikes/extraction/src/providers/types.ts`/`gemini.ts`) — a dual
 * provider abstraction from day one (plan.md's own explicit design decision: "extraction accuracy
 * is the highest-risk dependency"), even though only Gemini ships this task. `extract` never
 * throws for a provider-side failure (empty response, malformed JSON, a rejected API call) — it
 * returns `error` set instead, so a queue worker can record a real (if empty) extraction attempt
 * rather than crashing the job. I1 discipline: this interface returns raw extracted values with the
 * model's own confidence, never a computed business number — arithmetic validation is a separate,
 * later concern (007-07).
 */

export interface ExtractedField {
  value: string | null;
  confidence: number | null;
}

export interface ExtractedLine {
  sku: ExtractedField;
  description: ExtractedField;
  quantity: ExtractedField;
  unit: ExtractedField;
  unitPrice: ExtractedField;
  lineTotal: ExtractedField;
}

export interface ExtractedFields {
  supplier: ExtractedField;
  documentNumber: ExtractedField;
  documentDate: ExtractedField;
  currency: ExtractedField;
  subtotal: ExtractedField;
  tax: ExtractedField;
  discount: ExtractedField;
  total: ExtractedField;
}

export interface ExtractionResult {
  provider: string;
  modelVersion: string;
  latencyMs: number;
  error: string | null;
  fields: ExtractedFields | null;
  lines: ExtractedLine[] | null;
  overallConfidence: number | null;
}

export interface ExtractionProvider {
  name: string;
  extract(bytes: Buffer, mimeType: string): Promise<ExtractionResult>;
}
