import { afterEach, describe, expect, it, vi } from 'vitest';

const generateContentMock = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent: generateContentMock },
  })),
}));

const { createGeminiChatProvider } = await import('./gemini-chat-provider');

/**
 * `createGeminiChatProvider`'s own contract, independent of a live Gemini call — matching
 * `embedding-provider.test.ts`'s established mocking shape for this package. The real end-to-end
 * call against the actual API is verified manually, not asserted here — a unit
 * test pinned to live model output would be flaky by construction.
 */
describe('createGeminiChatProvider', () => {
  afterEach(() => {
    generateContentMock.mockReset();
  });

  it('returns the real text and model on a well-formed response', async () => {
    generateContentMock.mockResolvedValueOnce({ text: 'Food cost is 28.4% this period.' });

    const provider = createGeminiChatProvider('fake-key');
    const result = await provider.generate('What is my food cost?', 'gemini-flash-latest');

    expect(result).toEqual({
      provider: 'gemini',
      modelVersion: 'gemini-flash-latest',
      latencyMs: expect.any(Number),
      error: null,
      text: 'Food cost is 28.4% this period.',
    });
  });

  it('never throws for an empty response — sets error and text: null instead', async () => {
    generateContentMock.mockResolvedValueOnce({ text: undefined });

    const provider = createGeminiChatProvider('fake-key');
    const result = await provider.generate('prompt', 'gemini-flash-latest');

    expect(result.error).toBe('empty response text');
    expect(result.text).toBeNull();
  });

  it('never throws for a provider-side rejection — sets error and text: null instead', async () => {
    generateContentMock.mockRejectedValueOnce(new Error('rate limited'));

    const provider = createGeminiChatProvider('fake-key');
    const result = await provider.generate('prompt', 'gemini-flash-latest');

    expect(result.error).toBe('rate limited');
    expect(result.text).toBeNull();
  });

  /**
   * A 503 is Google-side capacity, not a bad request — the identical call usually succeeds moments
   * later. Before this retry existed, one transient spike failed an entire multi-hop investigation;
   * real `investigations` rows carry exactly this 503 body next to COMPLETE rows from the same key
   * and model.
   */
  it('retries a transient 503 and returns the success that follows it', async () => {
    generateContentMock
      .mockRejectedValueOnce(new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}'))
      .mockResolvedValueOnce({ text: 'recovered' });

    const provider = createGeminiChatProvider('fake-key');
    const result = await provider.generate('prompt', 'gemini-flash-latest');

    expect(result.error).toBeNull();
    expect(result.text).toBe('recovered');
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after a bounded number of attempts rather than retrying forever', async () => {
    generateContentMock.mockRejectedValue(new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}'));

    const provider = createGeminiChatProvider('fake-key');
    const result = await provider.generate('prompt', 'gemini-flash-latest');

    expect(result.text).toBeNull();
    expect(generateContentMock).toHaveBeenCalledTimes(3);
  });

  /**
   * A 429 means the quota is genuinely spent — retrying cannot succeed and actively worsens the
   * exhaustion. This project has hit real daily-quota exhaustion before, so excluding 429 from the
   * retry policy is deliberate, not an oversight.
   */
  it('does NOT retry a 429 quota rejection', async () => {
    generateContentMock.mockRejectedValue(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'));

    const provider = createGeminiChatProvider('fake-key');
    const result = await provider.generate('prompt', 'gemini-flash-latest');

    expect(result.text).toBeNull();
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a malformed-request error, which would fail identically every time', async () => {
    generateContentMock.mockRejectedValue(new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}'));

    const provider = createGeminiChatProvider('fake-key');
    await provider.generate('prompt', 'gemini-flash-latest');

    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it('passes the requested model straight through to the underlying call', async () => {
    generateContentMock.mockResolvedValueOnce({ text: 'ok' });

    const provider = createGeminiChatProvider('fake-key');
    await provider.generate('prompt', 'gemini-flash-lite-latest');

    expect(generateContentMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-flash-lite-latest' })
    );
  });
});

/**
 * `generateStructured`'s own contract — the schema-constrained JSON path that
 * `classifyIntent` (and the planning stage) depends on. Same never-throw discipline
 * as `generate`; additionally parses the response text as JSON and reports a malformed-JSON error
 * distinctly from an empty response, matching `document-classification.ts`'s established shape.
 */
describe('createGeminiChatProvider.generateStructured', () => {
  afterEach(() => {
    generateContentMock.mockReset();
  });

  it('returns the parsed JSON data on a well-formed response', async () => {
    generateContentMock.mockResolvedValueOnce({ text: JSON.stringify({ intent: 'METRIC', confidence: 0.9 }) });

    const provider = createGeminiChatProvider('fake-key');
    const result = await provider.generateStructured('classify this', 'gemini-flash-lite-latest', { type: 'object' });

    expect(result).toEqual({
      provider: 'gemini',
      modelVersion: 'gemini-flash-lite-latest',
      latencyMs: expect.any(Number),
      error: null,
      data: { intent: 'METRIC', confidence: 0.9 },
    });
  });

  it('degrades to a real error on malformed JSON, never throwing', async () => {
    generateContentMock.mockResolvedValueOnce({ text: 'not json{' });

    const provider = createGeminiChatProvider('fake-key');
    const result = await provider.generateStructured('classify this', 'gemini-flash-lite-latest', { type: 'object' });

    expect(result.error).toContain('malformed JSON');
    expect(result.data).toBeNull();
  });

  it('never throws for an empty response — sets error and data: null instead', async () => {
    generateContentMock.mockResolvedValueOnce({ text: undefined });

    const provider = createGeminiChatProvider('fake-key');
    const result = await provider.generateStructured('classify this', 'gemini-flash-lite-latest', { type: 'object' });

    expect(result.error).toBe('empty response text');
    expect(result.data).toBeNull();
  });

  it('never throws for a provider-side rejection — sets error and data: null instead', async () => {
    generateContentMock.mockRejectedValueOnce(new Error('rate limited'));

    const provider = createGeminiChatProvider('fake-key');
    const result = await provider.generateStructured('classify this', 'gemini-flash-lite-latest', { type: 'object' });

    expect(result.error).toBe('rate limited');
    expect(result.data).toBeNull();
  });

  it('passes the schema through to the underlying call as responseSchema', async () => {
    generateContentMock.mockResolvedValueOnce({ text: '{}' });
    const schema = { type: 'object', properties: { intent: { type: 'string' } } };

    const provider = createGeminiChatProvider('fake-key');
    await provider.generateStructured('classify this', 'gemini-flash-lite-latest', schema);

    expect(generateContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ responseSchema: schema, responseMimeType: 'application/json' }),
      })
    );
  });
});
