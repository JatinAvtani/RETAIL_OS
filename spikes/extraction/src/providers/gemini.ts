import { GoogleGenAI, Type } from "@google/genai";
import type { ExtractionProvider, ExtractionResult } from "./types.js";

const FIELD_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    value: { type: Type.STRING, nullable: true },
    confidence: { type: Type.NUMBER, description: "0 to 1, your subjective confidence in this value" },
  },
  required: ["value", "confidence"],
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
  required: ["sku", "description", "quantity", "unit", "unitPrice", "lineTotal"],
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
  required: ["supplier", "documentNumber", "documentDate", "currency", "subtotal", "tax", "total", "lines"],
};

const PROMPT = `You are extracting structured data from a supplier invoice image for a restaurant/café operations system. The image may be a phone photo: it can be angled, faded, blurry, or partially cropped.

Extract every field defined in the response schema. Rules:
- If a field is illegible, ambiguous, or absent, set its "value" to null. Never guess a plausible-looking number to fill a gap — a null is correct, a guessed value is not.
- "confidence" is your own subjective 0-1 estimate of correctness for that specific field, not a formatting confidence.
- Numbers (quantity, unitPrice, lineTotal, subtotal, tax, discount, total) must be plain decimal strings with no currency symbols or thousands separators, e.g. "1234.50" not "$1,234.50".
- documentDate must be normalized to YYYY-MM-DD.
- If the invoice spans multiple images (multiple pages of the same document), treat them as one invoice and merge all line items into a single "lines" array, preserving the order they appear.
- Extract every line item exactly as printed — do not summarize, merge, or omit any line.
- If there is no explicit discount line, set discount.value to null (do not default to "0").
- "sku" means a supplier product code (e.g. "FLR-T55-25"), not a row number or line index. If the invoice has no such code for a line — only a row number, or nothing at all — set sku.value to null. Do not use a row/line number as the sku.

Return only the structured JSON matching the schema.`;

export function createGeminiProvider(apiKey: string): ExtractionProvider {
  const client = new GoogleGenAI({ apiKey });
  // The only model this free-tier key has nonzero quota for, confirmed by probing
  // the API directly — gemini-2.5-flash and gemini-2.0-flash both 404/zero-quota
  // despite being listed by ListModels. Currently resolves to gemini-3.5-flash-lite.
  const model = "gemini-flash-lite-latest";

  return {
    name: "gemini-flash-lite-latest",

    async extract(images: Buffer[], mimeType: string, fileLabel: string): Promise<ExtractionResult> {
      const started = Date.now();
      const imageParts = images.map((buf) => ({
        inlineData: { mimeType, data: buf.toString("base64") },
      }));

      try {
        const response = await client.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: PROMPT }, ...imageParts] }],
          config: {
            responseMimeType: "application/json",
            responseSchema: INVOICE_SCHEMA,
          },
        });

        const latencyMs = Date.now() - started;
        const text = response.text;
        if (!text) {
          return {
            provider: model,
            file: fileLabel,
            latencyMs,
            error: "empty response text",
            fields: null,
            lines: null,
            raw: response,
          };
        }

        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          return {
            provider: model,
            file: fileLabel,
            latencyMs,
            error: `malformed JSON: ${(e as Error).message}`,
            fields: null,
            lines: null,
            raw: text,
          };
        }

        const { lines, ...fields } = parsed;
        return {
          provider: model,
          file: fileLabel,
          latencyMs,
          error: null,
          fields,
          lines: lines ?? [],
          raw: parsed,
        };
      } catch (e) {
        return {
          provider: model,
          file: fileLabel,
          latencyMs: Date.now() - started,
          error: (e as Error).message,
          fields: null,
          lines: null,
          raw: null,
        };
      }
    },
  };
}
