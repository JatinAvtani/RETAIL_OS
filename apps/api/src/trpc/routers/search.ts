import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { SearchRepository, type SearchResultRow } from '@retailos/db';
import { fuseRankedResults, shouldUseHybridSearch } from '@retailos/domain';
import { embedText } from '@retailos/ai';
import { protectedProcedure, router } from '../trpc';

const globalInput = z.object({
  query: z.string().min(1).max(200),
  /** Cap PER entity type (spec 11 §11.4: "top 5 each"), not a total result-count cap. */
  limitPerType: z.number().int().min(1).max(20).default(5),
});

const documentsInput = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(20).default(10),
});

/**
 * 009-17 (spec 11 §11.4) — the global command-palette search. One query fans out to every entity
 * type IN PARALLEL (the spec's own "~50ms budget each"), each already-scored and already-sorted by
 * `SearchRepository`; this procedure's only job is to run them concurrently, gate each type by the
 * permission its own detail endpoint already requires (never a hard 403 for the whole search —
 * `products.list`/`suppliers.list` are ungated, matching `SearchRepository`'s equivalent scope;
 * `purchaseOrders.get` requires `purchasing:read`; `documents`' review-adjacent endpoints require
 * `documents:read`), and merge results grouped by entity type — never a single flattened, re-ranked
 * list, since cross-entity score normalization (spec 11 §11.4's own "normalize scores per type")
 * is a genuinely harder relevance problem this task does not attempt to solve; grouping by type with
 * each group internally ranked is the honest, buildable version.
 *
 * Facets are deliberately NOT built in this pass — confirmed with the user: spec 11 §11.7 rule 2's
 * facet-count role-filtering (a Staff user must not learn a $50k invoice exists via a facet count)
 * has no existing query-time suppression mechanism in this codebase (only response-level field
 * stripping via `filterSensitiveFields`), and building real per-facet permission logic is separate,
 * larger scope from shipping correctly-permissioned RESULT ranking first.
 */
export const searchRouter = router({
  global: protectedProcedure.input(globalInput).query(async ({ ctx, input }) => {
    const repo = new SearchRepository(ctx.db, ctx.session.organizationId);
    const permissions = ctx.session.permissions as string[];

    const [products, suppliers, purchaseOrders, documents] = await Promise.all([
      repo.searchProducts(input.query, input.limitPerType),
      repo.searchSuppliers(input.query, input.limitPerType),
      permissions.includes('purchasing:read') ? repo.searchPurchaseOrders(input.query, input.limitPerType) : Promise.resolve<SearchResultRow[]>([]),
      permissions.includes('documents:read') ? repo.searchDocuments(input.query, input.limitPerType) : Promise.resolve<SearchResultRow[]>([]),
    ]);

    return {
      query: input.query,
      results: { products, suppliers, purchaseOrders, documents },
    };
  }),

  /**
   * 009-18 (spec 11 §11.5) — document search specifically, choosing lexical-only vs. hybrid
   * (lexical + vector, fused by RRF) via `shouldUseHybridSearch`'s routing heuristic: short/
   * identifier-like queries never pay for an embedding call at all (spec 11's own "not the default
   * path" framing) — only long, natural-language, question-like queries route to hybrid. Requires
   * `documents:read`, matching `search.global`'s own document-result gating (a hard 403 here,
   * unlike `global`'s graceful per-type omission, since this endpoint's entire purpose is
   * documents — there is nothing left to return without that permission).
   */
  documents: protectedProcedure.input(documentsInput).query(async ({ ctx, input }) => {
    const permissions = ctx.session.permissions as string[];
    if (!permissions.includes('documents:read')) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to search documents.' });
    }

    const repo = new SearchRepository(ctx.db, ctx.session.organizationId);
    const useHybrid = shouldUseHybridSearch(input.query);

    const lexicalOnly = async () => ({ query: input.query, mode: 'lexical' as const, results: await repo.searchDocuments(input.query, input.limit) });

    if (!useHybrid) {
      return lexicalOnly();
    }

    const apiKey = process.env.GEMINI_API_KEY;
    // No Gemini key configured (e.g. CI, a fresh local clone) — degrade to lexical-only rather
    // than fail the whole search, matching classifyDocument's own established no-key convention.
    if (!apiKey) {
      return lexicalOnly();
    }

    const lexicalResults = await repo.searchDocuments(input.query, 50);

    let vectorRanked: { id: string; rank: number; title: string; subtitle: string | null }[] = [];
    try {
      const embedding = await embedText(apiKey, input.query);
      vectorRanked = await repo.searchDocumentsByVector(embedding.values, 50);
    } catch (err) {
      // A real Gemini failure (rate limit, timeout) degrades to lexical-only — a search that
      // still works, just without the semantic half, never a hard failure for the whole query.
      console.warn(`Vector search failed for a hybrid document query:`, err);
      return lexicalOnly();
    }

    // Every result's title/subtitle is available from whichever list(s) actually returned it —
    // lexical results carry their own; vector results carry theirs; a document present in BOTH
    // just has its info set twice, harmlessly.
    const titleById = new Map<string, { title: string; subtitle: string | null }>();
    for (const r of lexicalResults) titleById.set(r.id, { title: r.title, subtitle: r.subtitle });
    for (const r of vectorRanked) titleById.set(r.id, { title: r.title, subtitle: r.subtitle });

    const lexicalRanked = lexicalResults.map((r, i) => ({ id: r.id, rank: i + 1 }));
    const fused = fuseRankedResults([
      lexicalRanked,
      vectorRanked.map((r) => ({ id: r.id, rank: r.rank })),
    ]).slice(0, input.limit);

    const results = fused.map((f) => ({
      entityType: 'document' as const,
      id: f.id,
      title: titleById.get(f.id)?.title ?? 'Untitled document',
      subtitle: titleById.get(f.id)?.subtitle ?? null,
      score: f.score,
    }));

    return { query: input.query, mode: 'hybrid' as const, results };
  }),
});
