/**
 * 009-18 (spec 11 §11.5) — the pure half of semantic search: the synthetic descriptive text a
 * document's embedding is built from, and Reciprocal Rank Fusion for merging a lexical result list
 * with a vector result list. Both are pure/no-I/O — the embedding call itself, and the two searches
 * being fused, are real I/O the caller (`apps/worker`'s embedding job, `apps/api`'s search router)
 * performs before/after calling into this module.
 */

/** The same shape `document_extractions.fields`/`.lines` stores as jsonb — declared locally rather than imported from `@retailos/ai` (packages/domain has zero `@retailos/*` dependencies, the base layer everything else builds on). */
export type ExtractedFieldValue = { value: string | null };
export type ExtractedDocumentFields = {
  supplier?: ExtractedFieldValue;
  documentNumber?: ExtractedFieldValue;
  documentDate?: ExtractedFieldValue;
  total?: ExtractedFieldValue;
};
export type ExtractedDocumentLine = { description?: ExtractedFieldValue };

/**
 * No raw OCR text is persisted anywhere in this schema (confirmed with the user before building
 * this task) — Gemini's extraction path goes straight to structured JSON, and Tesseract's raw text
 * is computed then discarded. This assembles a real, honest synthetic description from the
 * ALREADY-EXTRACTED structured fields instead — spec 11 §11.5's own "entity descriptions" corpus
 * type, not a fabricated substitute for literal OCR full-text. A field with `value: null` (I7 —
 * genuinely unextracted, not just empty) is omitted entirely rather than rendered as the literal
 * string "null" or an empty slot — an omitted fact should not shape what the embedding represents.
 * Line-item descriptions are the highest-value part for conceptual queries ("invoices about
 * flour") since they're the only genuinely free-text field this schema captures at all.
 */
export const buildDocumentEmbeddingText = (fields: ExtractedDocumentFields, lines: ExtractedDocumentLine[]): string => {
  const parts: string[] = [];
  if (fields.supplier?.value) parts.push(`Supplier: ${fields.supplier.value}`);
  if (fields.documentNumber?.value) parts.push(`Document number: ${fields.documentNumber.value}`);
  if (fields.documentDate?.value) parts.push(`Date: ${fields.documentDate.value}`);
  if (fields.total?.value) parts.push(`Total: ${fields.total.value}`);

  const descriptions = lines.map((line) => line.description?.value).filter((value): value is string => Boolean(value));
  if (descriptions.length > 0) parts.push(`Line items: ${descriptions.join(', ')}`);

  return parts.join('. ');
};

export type RankedResult = { id: string; rank: number };
export type FusedResult = { id: string; score: number };

/**
 * Reciprocal Rank Fusion (spec 10 §10.4): `score = Σ 1/(k + rank_i)` across every list a result
 * appears in, `k = 60` (the spec's own literal constant — "requires no score normalization between
 * fundamentally different scoring scales, and is robust without per-tenant tuning"). A result
 * appearing in only one list still gets a real, valid score (just from that one list's term) —
 * RRF's whole point is not needing every list to agree before a result counts.
 *
 * Takes any number of RANKED lists (not just two) — spec 11 §11.4's global search already fuses
 * across independently-ranked entity types elsewhere; this stays general rather than hardcoding
 * "exactly lexical + vector."
 */
export const RRF_K = 60;

export const fuseRankedResults = (lists: RankedResult[][]): FusedResult[] => {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (const { id, rank } of list) {
      const current = scores.get(id) ?? 0;
      scores.set(id, current + 1 / (RRF_K + rank));
    }
  }
  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
};

/**
 * spec 11 §11.5's routing heuristic, verbatim: "short queries and identifier patterns → lexical
 * only. Long natural-language queries (>4 words, question-like) → hybrid with RRF." A question-like
 * query is one ending in '?' or starting with a common interrogative word — the two textbook
 * signals of a natural-language question, not an exhaustive NLP classifier (this task's own scope
 * is the fusion math and the routing gate, not a language model for query understanding).
 */
const QUESTION_WORDS = new Set(['what', 'which', 'where', 'when', 'who', 'why', 'how']);

export const shouldUseHybridSearch = (query: string): boolean => {
  const trimmed = query.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length <= 4) return false;
  const firstWord = words[0]!.toLowerCase().replace(/[^a-z]/g, '');
  return trimmed.endsWith('?') || QUESTION_WORDS.has(firstWord);
};
