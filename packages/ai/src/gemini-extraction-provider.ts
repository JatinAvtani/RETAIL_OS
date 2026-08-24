import { GoogleGenAI, Type } from '@google/genai';
import type { ExtractedField, ExtractedFields, ExtractedLine, ExtractionProvider, ExtractionResult } from './extraction-provider';

const FIELD_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    value: { type: Type.STRING, nullable: true },
    confidence: { type: Type.NUMBER, description: '0 to 1, your subjective confidence in this value' },
  },
  required: ['value', 'confidence'],
};

const LINE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    sku: FIELD_SCHEMA,
    description: FIELD_SCHEMA,
    quantity: FIELD_SCHEMA,
    unit: FIELD_SCHEMA,
    unitPrice: FIELD_SCHEMA,
    lineTotal: FIELD_SCHEMA,
  },
  required: ['sku', 'description', 'quantity', 'unit', 'unitPrice', 'lineTotal'],
};

const INVOICE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    supplier: FIELD_SCHEMA,
    documentNumber: FIELD_SCHEMA,
    documentDate: FIELD_SCHEMA,
    currency: FIELD_SCHEMA,
    subtotal: FIELD_SCHEMA,
    tax: FIELD_SCHEMA,
    discount: FIELD_SCHEMA,
    total: FIELD_SCHEMA,
    lines: { type: Type.ARRAY, items: LINE_SCHEMA },
  },
  required: ['supplier', 'documentNumber', 'documentDate', 'currency', 'subtotal', 'tax', 'total', 'lines'],
};

/**
 * Verbatim (mechanically ported) from the a later milestone extraction spike's validated prompt
 * (`spikes/extraction/src/providers/gemini.ts`) — this exact wording is what the spike's measured
 * 100%/85.7%→100% accuracy numbers were produced against. Confirmed separately (earlier work, this
 * session) that Gemini's `inlineData` genuinely reads a real PDF's content directly — a real
 * invoice PDF classified correctly at 0.95 confidence via the same inline-data mechanism used here
 * — so no PDF-to-image conversion step is needed, unlike the spike's own corpus generation (which
 * rendered PNGs via Playwright for a different reason: producing a *degraded-photo* variant to test
 * against, not because Gemini can't read PDFs).
 */
const PROMPT = `You are extracting structured data from a supplier invoice for a restaurant/café operations system. The document may be a phone photo of a paper invoice: it can be angled, faded, blurry, or partially cropped. It may also be a clean PDF.

Extract every field defined in the response schema. Rules:
- If a field is illegible, ambiguous, or absent, set its "value" to null. Never guess a plausible-looking number to fill a gap — a null is correct, a guessed value is not.
- "confidence" is your own subjective 0-1 estimate of correctness for that specific field, not a formatting confidence.
- Numbers (quantity, unitPrice, lineTotal, subtotal, tax, discount, total) must be plain decimal strings with no currency symbols or thousands separators, e.g. "1234.50" not "$1,234.50".
- documentDate must be normalized to YYYY-MM-DD.
- If the document spans multiple pages, treat them as one invoice and merge all line items into a single "lines" array, preserving the order they appear.
- Extract every line item exactly as printed — do not summarize, merge, or omit any line.
- If there is no explicit discount line, set discount.value to null (do not default to "0").
- "sku" means a supplier product code (e.g. "FLR-T55-25"), not a row number or line index. If the invoice has no such code for a line — only a row number, or nothing at all — set sku.value to null. Do not use a row/line number as the sku.

Return only the structured JSON matching the schema.`;

const MODEL = 'gemini-flash-lite-latest';

/**
 * Without an explicit timeout, a slow (not just erroring) Gemini response can block the circuit
 * breaker (`circuit-breaker-extraction-provider.ts`) from failing over for however long the SDK's
 * underlying HTTP call takes — defeating the breaker's whole purpose of a fast, bounded fallback.
 * Confirmed as a real gap, not a hypothetical: a genuinely invalid API key (a 401, not one of the
 * SDK's own retryable status codes) still took ~60s+ to resolve on GitHub Actions' network path to
 * Gemini's API, well beyond typical local network latency — an unbounded `await` on
 * that call is exactly the failure mode a circuit breaker exists to prevent.
 */
const REQUEST_TIMEOUT_MS = 15_000;

const isExtractedField = (value: unknown): value is ExtractedField => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.value === null || typeof v.value === 'string') && (v.confidence === null || typeof v.confidence === 'number');
};

const isExtractedLine = (value: unknown): value is ExtractedLine => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return ['sku', 'description', 'quantity', 'unit', 'unitPrice', 'lineTotal'].every((key) => isExtractedField(v[key]));
};

const isExtractedFields = (value: unknown): value is ExtractedFields => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return ['supplier', 'documentNumber', 'documentDate', 'currency', 'subtotal', 'tax', 'discount', 'total'].every((key) => isExtractedField(v[key]));
};

/** Mean of every present field/line confidence — a plain, deterministic aggregate over the model's own numbers, not a computed business figure (I1 is about money/quantity arithmetic, not this). `null` when nothing has a confidence at all, never a fabricated 0. */
const computeOverallConfidence = (fields: ExtractedFields, lines: ExtractedLine[]): number | null => {
  const confidences: number[] = [];
  for (const field of Object.values(fields)) {
    if (field.confidence !== null) confidences.push(field.confidence);
  }
  for (const line of lines) {
    for (const field of Object.values(line)) {
      if (field.confidence !== null) confidences.push(field.confidence);
    }
  }
  if (confidences.length === 0) return null;
  return confidences.reduce((sum, c) => sum + c, 0) / confidences.length;
};

export const createGeminiExtractionProvider = (apiKey: string): ExtractionProvider => {
  const client = new GoogleGenAI({ apiKey });

  return {
    name: 'gemini',

    async extract(bytes: Buffer, mimeType: string): Promise<ExtractionResult> {
      const started = Date.now();

      try {
        const response = await client.models.generateContent({
          model: MODEL,
          contents: [{ role: 'user', parts: [{ text: PROMPT }, { inlineData: { mimeType, data: bytes.toString('base64') } }] }],
          config: {
            responseMimeType: 'application/json',
            responseSchema: INVOICE_SCHEMA,
            httpOptions: { timeout: REQUEST_TIMEOUT_MS },
          },
        });

        const latencyMs = Date.now() - started;
        const text = response.text;
        if (!text) {
          return { provider: 'gemini', modelVersion: MODEL, latencyMs, error: 'empty response text', fields: null, lines: null, overallConfidence: null };
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          return { provider: 'gemini', modelVersion: MODEL, latencyMs, error: `malformed JSON: ${(e as Error).message}`, fields: null, lines: null, overallConfidence: null };
        }

        if (typeof parsed !== 'object' || parsed === null) {
          return { provider: 'gemini', modelVersion: MODEL, latencyMs, error: 'response was not a JSON object', fields: null, lines: null, overallConfidence: null };
        }

        const { lines: rawLines, ...rawFields } = parsed as Record<string, unknown>;
        if (!isExtractedFields(rawFields)) {
          return { provider: 'gemini', modelVersion: MODEL, latencyMs, error: 'response fields did not match the expected extraction shape', fields: null, lines: null, overallConfidence: null };
        }
        const lines: ExtractedLine[] = Array.isArray(rawLines) ? rawLines.filter(isExtractedLine) : [];

        return {
          provider: 'gemini',
          modelVersion: MODEL,
          latencyMs,
          error: null,
          fields: rawFields,
          lines,
          overallConfidence: computeOverallConfidence(rawFields, lines),
        };
      } catch (e) {
        return { provider: 'gemini', modelVersion: MODEL, latencyMs: Date.now() - started, error: (e as Error).message, fields: null, lines: null, overallConfidence: null };
      }
    },
  };
};
