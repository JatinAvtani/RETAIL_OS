export interface ExtractedField {
  value: string | null;
  confidence: number | null; // 0-1, null if provider gives none
}

export interface ExtractedLine {
  sku: ExtractedField;
  description: ExtractedField;
  quantity: ExtractedField;
  unit: ExtractedField;
  unitPrice: ExtractedField;
  lineTotal: ExtractedField;
}

export interface ExtractionResult {
  provider: string;
  file: string;
  latencyMs: number;
  error: string | null; // set instead of throwing — a failed extraction is a data point, not a crash
  fields: {
    supplier: ExtractedField;
    documentNumber: ExtractedField;
    documentDate: ExtractedField;
    currency: ExtractedField;
    subtotal: ExtractedField;
    tax: ExtractedField;
    discount: ExtractedField;
    total: ExtractedField;
  } | null;
  lines: ExtractedLine[] | null;
  raw: unknown; // full provider response, kept for debugging
}

export interface ExtractionProvider {
  name: string;
  extract(images: Buffer[], mimeType: string, fileLabel: string): Promise<ExtractionResult>;
}
