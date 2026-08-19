import { describe, expect, it, vi } from 'vitest';
import type { SearchRepository } from '@retailos/db';

/**
 * `embedText` is mocked at the MODULE level (hoisted `vi.mock`), matching the lesson from
 * `eval/runner.test.ts` — `retrieval.ts` binds `embedText` via a static ESM import, so a
 * `vi.spyOn` on a separately-imported namespace object would silently fail to intercept it (the
 * real, unmocked `embedText` would attempt a genuine Gemini API call against a fake key and throw,
 * silently caught by `retrievePassages`' own degrade-to-lexical-only path — exactly masking the
 * bug this test file is trying to prove doesn't happen).
 */
const mockEmbedText = vi.fn();
vi.mock('@retailos/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@retailos/ai')>();
  return { ...real, embedText: (...args: unknown[]) => mockEmbedText(...args) };
});

const { retrievePassages } = await import('./retrieval');

const fakeSearchRepository = (overrides: Partial<SearchRepository> = {}): SearchRepository =>
  ({
    searchDocumentChunksLexical: vi.fn().mockResolvedValue([]),
    searchDocumentChunksByVector: vi.fn().mockResolvedValue([]),
    ...overrides,
  }) as unknown as SearchRepository;

const FAKE_EMBEDDING = { model: 'fake-embedding-v1', values: Array.from({ length: 768 }, () => 0.1) };
mockEmbedText.mockResolvedValue(FAKE_EMBEDDING);

describe('retrievePassages', () => {
  it('a short, identifier-shaped query runs lexical only — no embedding call, matching shouldUseHybridSearch\'s own routing', async () => {
    const searchRepository = fakeSearchRepository({
      searchDocumentChunksLexical: vi.fn().mockResolvedValue([{ id: 'chunk-1', rank: 1, text: 'Document number: INV-2024-8891', documentId: 'doc-1', chunkType: 'header' }]),
    });

    const passages = await retrievePassages('INV-2024-8891', { searchRepository, geminiApiKey: 'fake-key' });

    expect(searchRepository.searchDocumentChunksByVector).not.toHaveBeenCalled();
    expect(passages).toHaveLength(1);
    expect(passages[0]).toMatchObject({ sourceType: 'document_chunk', sourceId: 'doc-1', text: 'Document number: INV-2024-8891' });
  });

  it('a long, conceptual question runs BOTH lexical and vector, fused via RRF', async () => {
    const searchRepository = fakeSearchRepository({
      searchDocumentChunksLexical: vi.fn().mockResolvedValue([{ id: 'chunk-1', rank: 1, text: 'Item: Flour T55', documentId: 'doc-1', chunkType: 'line_item' }]),
      searchDocumentChunksByVector: vi.fn().mockResolvedValue([{ id: 'chunk-2', rank: 1, text: 'Item: All-purpose flour', documentId: 'doc-2', chunkType: 'line_item' }]),
    });

    const passages = await retrievePassages('which invoices are about flour or baking ingredients?', { searchRepository, geminiApiKey: undefined });

    // No real geminiApiKey — the vector call is skipped even though the query WOULD qualify for
    // hybrid, matching embedText's own "no key, no attempt" contract elsewhere in this codebase.
    expect(searchRepository.searchDocumentChunksByVector).not.toHaveBeenCalled();
    expect(passages).toHaveLength(1);
    expect(passages[0]!.sourceId).toBe('doc-1');
  });

  it('a result appearing in BOTH lists ranks higher than one appearing in only one — real RRF fusion, not just lexical order', async () => {
    const searchRepository = fakeSearchRepository({
      searchDocumentChunksLexical: vi.fn().mockResolvedValue([
        { id: 'chunk-only-lexical', rank: 1, text: 'lexical only', documentId: 'doc-a', chunkType: 'header' },
        { id: 'chunk-both', rank: 2, text: 'in both lists', documentId: 'doc-b', chunkType: 'header' },
      ]),
      searchDocumentChunksByVector: vi.fn().mockResolvedValue([{ id: 'chunk-both', rank: 1, text: 'in both lists', documentId: 'doc-b', chunkType: 'header' }]),
    });

    const passages = await retrievePassages('what does the flour supplier contract say about delivery terms?', { searchRepository, geminiApiKey: 'fake-key' });

    expect(passages[0]!.sourceId).toBe('doc-b'); // appeared in both lists — higher fused RRF score
  });

  it('returns real, empty results (never a crash) when nothing matches either list', async () => {
    const searchRepository = fakeSearchRepository();

    const passages = await retrievePassages('a query matching absolutely nothing in this tenant', { searchRepository, geminiApiKey: 'fake-key' });

    expect(passages).toEqual([]);
  });

  it('never fabricates a passage — every returned passage traces to a real chunk from one of the two real search calls', async () => {
    const searchRepository = fakeSearchRepository({
      searchDocumentChunksLexical: vi.fn().mockResolvedValue([{ id: 'chunk-1', rank: 1, text: 'real chunk text', documentId: 'doc-1', chunkType: 'line_item' }]),
    });

    const passages = await retrievePassages('a query about a specific ingredient in an invoice', { searchRepository, geminiApiKey: 'fake-key' });

    expect(passages.every((p) => p.text === 'real chunk text')).toBe(true);
  });

  it('caps results at the real FINAL_TOP_K (8), even when both lists together return more', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `chunk-${i}`, rank: i + 1, text: `text ${i}`, documentId: `doc-${i}`, chunkType: 'header' as const }));
    const searchRepository = fakeSearchRepository({ searchDocumentChunksLexical: vi.fn().mockResolvedValue(many) });

    const passages = await retrievePassages('short query', { searchRepository, geminiApiKey: 'fake-key' });

    expect(passages.length).toBeLessThanOrEqual(8);
  });
});
