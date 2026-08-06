import { GoogleGenAI, Type } from '@google/genai';

/**
 * 007-04 (plan.md Phase 1, F3): classify an uploaded document into one of `documentTypeEnum`'s
 * values before extraction (007-05/06) exists. This is a routing label, not a business number —
 * I1 is about arithmetic/money/quantity, not classification — but the same "never trust the model
 * past its own schema" discipline applies: an unrecognized label or a call that errors/times out
 * degrades to `'OTHER'` with zero confidence, never a guessed specific type (I7's reasoning,
 * applied to a label instead of a number).
 */
export const CLASSIFIABLE_DOCUMENT_TYPES = [
  'INVOICE',
  'DELIVERY_NOTE',
  'CREDIT_NOTE',
  'QUOTE',
  'CONTRACT',
  'CERTIFICATE',
  'OTHER',
] as const;

export type ClassifiableDocumentType = (typeof CLASSIFIABLE_DOCUMENT_TYPES)[number];

export interface DocumentClassificationResult {
  type: ClassifiableDocumentType;
  confidence: number;
  /** Set only when classification could not be attempted at all (provider error, timeout, malformed response) — distinct from a genuine low-confidence 'OTHER' classification. */
  error: string | null;
}

const CLASSIFICATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    type: { type: Type.STRING, enum: [...CLASSIFIABLE_DOCUMENT_TYPES] },
    confidence: { type: Type.NUMBER, description: '0 to 1, your subjective confidence in this classification' },
  },
  required: ['type', 'confidence'],
};

const PROMPT = `You are classifying a supplier-facing business document for a restaurant/café operations system. The image may be a phone photo: it can be angled, faded, blurry, or partially cropped.

Classify it into exactly one of these types:
- INVOICE: a bill requesting payment for goods/services already supplied
- DELIVERY_NOTE: a packing slip / goods-received note listing items delivered, no payment request
- CREDIT_NOTE: a supplier-issued credit or refund document
- QUOTE: a price quotation, not yet a commitment to buy
- CONTRACT: a supply agreement or terms document
- CERTIFICATE: a compliance/inspection/insurance certificate
- OTHER: anything that doesn't clearly fit the above, or that you cannot confidently read at all

If the document is illegible, ambiguous, or genuinely doesn't match any specific category, choose OTHER with low confidence rather than guessing a specific type you aren't sure of.

Return only the structured JSON matching the schema.`;

/**
 * Real Gemini vision call — same model/schema-constrained-JSON shape the EPIC-002 extraction spike
 * validated (`spikes/extraction/src/providers/gemini.ts`), scoped down to a single label+confidence
 * instead of full field/line extraction. `mimeType` must be one of the formats
 * `packages/storage`'s `validateDocumentUpload` already verified by magic bytes — this function
 * trusts its caller to have done that check, not the caller's claimed content-type.
 */
export const classifyDocument = async (
  apiKey: string,
  bytes: Buffer,
  mimeType: string
): Promise<DocumentClassificationResult> => {
  const client = new GoogleGenAI({ apiKey });
  const model = 'gemini-flash-lite-latest';

  try {
    const response = await client.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [{ text: PROMPT }, { inlineData: { mimeType, data: bytes.toString('base64') } }],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: CLASSIFICATION_SCHEMA,
      },
    });

    const text = response.text;
    if (!text) {
      return { type: 'OTHER', confidence: 0, error: 'empty response text' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { type: 'OTHER', confidence: 0, error: `malformed JSON: ${(e as Error).message}` };
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('type' in parsed) ||
      !('confidence' in parsed) ||
      typeof (parsed as { confidence: unknown }).confidence !== 'number' ||
      !CLASSIFIABLE_DOCUMENT_TYPES.includes((parsed as { type: ClassifiableDocumentType }).type)
    ) {
      return { type: 'OTHER', confidence: 0, error: 'response did not match the expected classification shape' };
    }

    const result = parsed as { type: ClassifiableDocumentType; confidence: number };
    return { type: result.type, confidence: result.confidence, error: null };
  } catch (e) {
    return { type: 'OTHER', confidence: 0, error: (e as Error).message };
  }
};
