import { afterEach, describe, expect, it, vi } from 'vitest';

const generateContentMock = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent: generateContentMock },
  })),
  Type: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER' },
}));

const { classifyDocument } = await import('./document-classification');

/**
 * 007-04: `classifyDocument`'s own contract, independent of whether a real Gemini call ever
 * succeeds — every failure mode (empty response, malformed JSON, a shape that doesn't match the
 * schema, a thrown error) must degrade to `{ type: 'OTHER', confidence: 0, error: <reason> }`,
 * never a guessed specific type (I7's reasoning applied to a label, not a number). The real
 * end-to-end call against the actual Gemini API is verified manually (see task notes), not here —
 * a unit test asserting a live model's classification would be flaky by construction.
 */
describe('classifyDocument', () => {
  afterEach(() => {
    generateContentMock.mockReset();
  });

  it('returns the classified type and confidence on a well-formed response', async () => {
    generateContentMock.mockResolvedValueOnce({ text: JSON.stringify({ type: 'INVOICE', confidence: 0.92 }) });

    const result = await classifyDocument('fake-key', Buffer.from('pdf-bytes'), 'application/pdf');

    expect(result).toEqual({ type: 'INVOICE', confidence: 0.92, error: null });
  });

  it('degrades to OTHER with zero confidence on an empty response', async () => {
    generateContentMock.mockResolvedValueOnce({ text: '' });

    const result = await classifyDocument('fake-key', Buffer.from('bytes'), 'application/pdf');

    expect(result.type).toBe('OTHER');
    expect(result.confidence).toBe(0);
    expect(result.error).toContain('empty response');
  });

  it('degrades to OTHER on malformed JSON, never throwing', async () => {
    generateContentMock.mockResolvedValueOnce({ text: 'not json{' });

    const result = await classifyDocument('fake-key', Buffer.from('bytes'), 'application/pdf');

    expect(result.type).toBe('OTHER');
    expect(result.confidence).toBe(0);
    expect(result.error).toContain('malformed JSON');
  });

  it('degrades to OTHER when the response type is not one of the allowed values', async () => {
    generateContentMock.mockResolvedValueOnce({ text: JSON.stringify({ type: 'RECEIPT', confidence: 0.8 }) });

    const result = await classifyDocument('fake-key', Buffer.from('bytes'), 'application/pdf');

    expect(result.type).toBe('OTHER');
    expect(result.confidence).toBe(0);
    expect(result.error).toContain('expected classification shape');
  });

  it('degrades to OTHER when confidence is missing or not a number', async () => {
    generateContentMock.mockResolvedValueOnce({ text: JSON.stringify({ type: 'INVOICE' }) });

    const result = await classifyDocument('fake-key', Buffer.from('bytes'), 'application/pdf');

    expect(result.type).toBe('OTHER');
    expect(result.error).toContain('expected classification shape');
  });

  it('degrades to OTHER, not a thrown error, when the provider call itself rejects', async () => {
    generateContentMock.mockRejectedValueOnce(new Error('503 Service Unavailable'));

    const result = await classifyDocument('fake-key', Buffer.from('bytes'), 'application/pdf');

    expect(result.type).toBe('OTHER');
    expect(result.confidence).toBe(0);
    expect(result.error).toBe('503 Service Unavailable');
  });

  it('accepts a genuinely low-confidence OTHER classification as a real result, not an error', async () => {
    generateContentMock.mockResolvedValueOnce({ text: JSON.stringify({ type: 'OTHER', confidence: 0.15 }) });

    const result = await classifyDocument('fake-key', Buffer.from('bytes'), 'image/jpeg');

    expect(result).toEqual({ type: 'OTHER', confidence: 0.15, error: null });
  });
});
