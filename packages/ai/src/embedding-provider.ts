import { GoogleGenAI } from '@google/genai';

/**
 * real Gemini embeddings, the SAME `GEMINI_API_KEY` already used for
 * extraction (`gemini-extraction-provider.ts`) and classification (`document-classification.ts`) —
 * no new cost, no new provider account (the project's standing "no card, no cost" constraint).
 *
 * `text-embedding-004` (the model this project's own spec/docs originally assumed) is genuinely
 * NOT available for this API key — a live call confirmed a real 404
 * ("is not found for API version v1beta, or is not supported for embedContent"), not assumed from
 * documentation. `gemini-embedding-001` is the real, currently-available model, confirmed directly
 * via `GET /v1beta/models?key=...` filtering for `embedContent` support. Its raw default output is
 * 3072 dimensions; `outputDimensionality: EMBEDDING_DIMENSIONS` truncates it to 768 (confirmed via
 * a real live call returning exactly 768 values), matching the `vector(768)` column
 * `0042_document_embeddings.sql` created — 768 chosen as a real, common, HNSW-friendly size rather
 * than accepting the full 3072 (larger vectors cost more index space/query time for the same
 * relative-ranking quality at this project's scale).
 *
 * Deliberately narrower than `ExtractionProvider`'s error-tolerant shape — a failed embedding call
 * means "this document doesn't get a semantic-search entry yet," never a fabricated all-zero
 * vector (a zero vector is NOT "no data," it is a specific point in the embedding space that would
 * silently rank as similar to other near-zero, unrelated embeddings). The caller (the embedding
 * worker job) is expected to catch the thrown error and simply not write a row, matching this
 * schema's own "documents without an embedding row are just not in the semantic index" design.
 */
export interface EmbeddingResult {
  model: string;
  values: number[];
}

export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMENSIONS = 768;

export const embedText = async (apiKey: string, text: string): Promise<EmbeddingResult> => {
  const client = new GoogleGenAI({ apiKey });

  const response = await client.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: [{ role: 'user', parts: [{ text }] }],
    config: { outputDimensionality: EMBEDDING_DIMENSIONS },
  });

  const values = response.embeddings?.[0]?.values;
  if (!values || values.length === 0) {
    throw new Error('Gemini embedContent returned no embedding values.');
  }

  return { model: EMBEDDING_MODEL, values };
};
