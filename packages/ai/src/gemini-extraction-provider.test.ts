import { afterEach, describe, expect, it, vi } from 'vitest';

const generateContentMock = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent: generateContentMock },
  })),
  Type: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER', ARRAY: 'ARRAY' },
}));

const { createGeminiExtractionProvider } = await import('./gemini-extraction-provider');

const wellFormedResponse = {
  supplier: { value: 'Nova Foods', confidence: 0.98 },
  documentNumber: { value: 'INV-8891', confidence: 0.95 },
  documentDate: { value: '2026-01-15', confidence: 0.9 },
  currency: { value: 'USD', confidence: 1 },
  subtotal: { value: '100.00', confidence: 0.9 },
  tax: { value: '8.00', confidence: 0.9 },
  discount: { value: null, confidence: null },
  total: { value: '108.00', confidence: 0.92 },
  lines: [
    {
      sku: { value: 'FLR-T55-25', confidence: 0.85 },
      description: { value: 'Flour T55 25kg', confidence: 0.95 },
      quantity: { value: '4', confidence: 0.9 },
      unit: { value: 'bag', confidence: 0.9 },
      unitPrice: { value: '25.00', confidence: 0.88 },
      lineTotal: { value: '100.00', confidence: 0.9 },
    },
  ],
};

describe('createGeminiExtractionProvider', () => {
  afterEach(() => {
    generateContentMock.mockReset();
  });

  it('returns parsed fields, lines, and a computed overallConfidence on a well-formed response', async () => {
    generateContentMock.mockResolvedValueOnce({ text: JSON.stringify(wellFormedResponse) });

    const provider = createGeminiExtractionProvider('fake-key');
    const result = await provider.extract(Buffer.from('pdf-bytes'), 'application/pdf');

    expect(result.error).toBeNull();
    expect(result.provider).toBe('gemini');
    expect(result.fields?.supplier.value).toBe('Nova Foods');
    expect(result.lines).toHaveLength(1);
    expect(result.lines?.[0]?.sku.value).toBe('FLR-T55-25');
    expect(result.overallConfidence).not.toBeNull();
    expect(result.overallConfidence).toBeGreaterThan(0);
    expect(result.overallConfidence).toBeLessThanOrEqual(1);
  });

  it('excludes null confidences from the overallConfidence average, never treating them as zero', async () => {
    generateContentMock.mockResolvedValueOnce({ text: JSON.stringify(wellFormedResponse) });
    const provider = createGeminiExtractionProvider('fake-key');
    const result = await provider.extract(Buffer.from('bytes'), 'application/pdf');

    // discount has confidence: null and must not drag the average toward 0.
    const allConfidences = [0.98, 0.95, 0.9, 1, 0.9, 0.9, 0.92, 0.85, 0.95, 0.9, 0.9, 0.88, 0.9];
    const expected = allConfidences.reduce((a, b) => a + b, 0) / allConfidences.length;
    expect(result.overallConfidence).toBeCloseTo(expected, 5);
  });

  it('returns overallConfidence null when every field/line confidence is null', async () => {
    const allNull = {
      ...Object.fromEntries(Object.keys(wellFormedResponse).filter((k) => k !== 'lines').map((k) => [k, { value: null, confidence: null }])),
      lines: [],
    };
    generateContentMock.mockResolvedValueOnce({ text: JSON.stringify(allNull) });
    const provider = createGeminiExtractionProvider('fake-key');
    const result = await provider.extract(Buffer.from('bytes'), 'application/pdf');

    expect(result.overallConfidence).toBeNull();
  });

  it('degrades to a real error, never throwing, on an empty response', async () => {
    generateContentMock.mockResolvedValueOnce({ text: '' });
    const provider = createGeminiExtractionProvider('fake-key');
    const result = await provider.extract(Buffer.from('bytes'), 'application/pdf');

    expect(result.error).toContain('empty response');
    expect(result.fields).toBeNull();
    expect(result.lines).toBeNull();
  });

  it('degrades to a real error on malformed JSON', async () => {
    generateContentMock.mockResolvedValueOnce({ text: 'not json{' });
    const provider = createGeminiExtractionProvider('fake-key');
    const result = await provider.extract(Buffer.from('bytes'), 'application/pdf');

    expect(result.error).toContain('malformed JSON');
  });

  it('degrades to a real error when required fields are missing from the response', async () => {
    generateContentMock.mockResolvedValueOnce({ text: JSON.stringify({ supplier: { value: 'X', confidence: 0.5 } }) });
    const provider = createGeminiExtractionProvider('fake-key');
    const result = await provider.extract(Buffer.from('bytes'), 'application/pdf');

    expect(result.error).toContain('expected extraction shape');
  });

  it('filters out malformed line entries rather than throwing', async () => {
    generateContentMock.mockResolvedValueOnce({
      text: JSON.stringify({ ...wellFormedResponse, lines: [wellFormedResponse.lines[0], { not: 'a real line' }] }),
    });
    const provider = createGeminiExtractionProvider('fake-key');
    const result = await provider.extract(Buffer.from('bytes'), 'application/pdf');

    expect(result.error).toBeNull();
    expect(result.lines).toHaveLength(1);
  });

  it('degrades to a real error, never throwing, when the provider call itself rejects', async () => {
    generateContentMock.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const provider = createGeminiExtractionProvider('fake-key');
    const result = await provider.extract(Buffer.from('bytes'), 'application/pdf');

    expect(result.error).toBe('503 Service Unavailable');
  });
});
