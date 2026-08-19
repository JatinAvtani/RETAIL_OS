import { fuseRankedResults, RRF_K, shouldUseHybridSearch, type RankedResult } from '@retailos/domain';
import { embedText } from '@retailos/ai';
import type { SearchRepository } from '@retailos/db';
import type { GroundingPassage } from './grounding-bundle';

/**
 * hybrid retrieval over document chunks: `BM25 (lexical) → top 50` +
 * `vector → top 50` → RRF fusion → top 8. Deliberately does NOT include the spec's own "cross-
 * encoder rerank" stage — a deliberate cut: no free cross-encoder API exists under
 * this project's no-card-no-cost constraint (the semantic-search work already deferred the same component once,
 * "confirmed separate, heavier scope"). RRF's own fused ranking IS the final order here — a real,
 * documented deviation from the spec's literal pipeline, not a silently dropped stage.
 *
 * Reuses `fuseRankedResults`/`RRF_K` (`@retailos/domain`, built for `search.hybrid`)
 * rather than a second RRF implementation (I2) — this is the SAME algorithm, a different pair of
 * ranked lists (chunk-lexical/chunk-vector instead of document-lexical/document-vector).
 *
 * `shouldUseHybridSearch` gates whether the vector half runs at all — a short,
 * identifier-shaped query ("find INV-2024-8891") is lexical-only, matching the design's own
 * "exact identifiers embed meaninglessly" reasoning; only a long, conceptual query pays for a real
 * embedding call.
 */
const TOP_K_PER_LIST = 50;
const FINAL_TOP_K = 8;

export type RetrievalDeps = {
  searchRepository: SearchRepository;
  geminiApiKey: string | undefined;
};

/**
 * Never throws for a provider-side embedding failure — degrades to lexical-only results, matching
 * `embedText`'s own "the caller catches and treats this as no embedding, never a fabricated
 * vector" contract (established in `embedding-processor.ts`). Tenant scoping happens
 * INSIDE `SearchRepository`'s own methods (an explicit `organization_id` predicate on every query,
 * not RLS alone) — the design's own "retrieval leakage is the likeliest serious security failure"
 * warning, already satisfied by reusing `SearchRepository` rather than writing a new query here.
 */
export const retrievePassages = async (query: string, deps: RetrievalDeps): Promise<GroundingPassage[]> => {
  const lexicalResults = await deps.searchRepository.searchDocumentChunksLexical(query, TOP_K_PER_LIST);

  let vectorResults: Awaited<ReturnType<typeof deps.searchRepository.searchDocumentChunksByVector>> = [];
  if (shouldUseHybridSearch(query) && deps.geminiApiKey) {
    try {
      const embedding = await embedText(deps.geminiApiKey, query);
      vectorResults = await deps.searchRepository.searchDocumentChunksByVector(embedding.values, TOP_K_PER_LIST);
    } catch {
      // A real embedding-provider failure — degrade to lexical-only, never a fabricated vector.
    }
  }

  const lexicalRanked: RankedResult[] = lexicalResults.map((r) => ({ id: r.id, rank: r.rank }));
  const vectorRanked: RankedResult[] = vectorResults.map((r) => ({ id: r.id, rank: r.rank }));
  const fused = fuseRankedResults([lexicalRanked, vectorRanked]);

  const byId = new Map([...lexicalResults, ...vectorResults].map((r) => [r.id, r]));

  return fused
    .slice(0, FINAL_TOP_K)
    .map((f): GroundingPassage | null => {
      const chunk = byId.get(f.id);
      return chunk ? { sourceType: 'document_chunk', sourceId: chunk.documentId, text: chunk.text, score: f.score } : null;
    })
    .filter((p): p is GroundingPassage => p !== null);
};

export { RRF_K };
