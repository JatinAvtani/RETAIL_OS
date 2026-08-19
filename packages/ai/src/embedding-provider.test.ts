import { afterEach, describe, expect, it, vi } from 'vitest';

const embedContentMock = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { embedContent: embedContentMock },
  })),
}));

const { embedText, EMBEDDING_MODEL } = await import('./embedding-provider');

/**
 * `embedText`'s own contract, independent of a live Gemini call — a well-formed response
 * returns the real values, and every failure shape (missing embeddings array, empty values array)
 * throws rather than fabricating a zero vector (I7 applied to an embedding: a zero vector is a
 * real, specific point in the embedding space, not "no data"). The real end-to-end call against
 * the actual Gemini API is verified manually, matching `document-classification.test.ts`'s own
 * established precedent for this package — a unit test asserting live model output would be flaky
 * by construction.
 */
describe('embedText', () => {
  afterEach(() => {
    embedContentMock.mockReset();
  });

  it('returns the real embedding values and model name on a well-formed response', async () => {
    const values = Array.from({ length: 768 }, (_, i) => i / 768);
    embedContentMock.mockResolvedValueOnce({ embeddings: [{ values }] });

    const result = await embedText('fake-key', 'Supplier: Acme. Total: 100.00');

    expect(result).toEqual({ model: EMBEDDING_MODEL, values });
  });

  it('throws when the response has no embeddings array at all', async () => {
    embedContentMock.mockResolvedValueOnce({});
    await expect(embedText('fake-key', 'text')).rejects.toThrow('no embedding values');
  });

  it('throws when the response has an empty values array', async () => {
    embedContentMock.mockResolvedValueOnce({ embeddings: [{ values: [] }] });
    await expect(embedText('fake-key', 'text')).rejects.toThrow('no embedding values');
  });

  it('a real provider error propagates rather than being swallowed into a fabricated result', async () => {
    embedContentMock.mockRejectedValueOnce(new Error('rate limited'));
    await expect(embedText('fake-key', 'text')).rejects.toThrow('rate limited');
  });
});
