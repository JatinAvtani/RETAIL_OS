import type { ExtractedField, ExtractedFields, ExtractedLine } from './extraction-types.js';

/**
 * Chunking design: "structure-aware for documents (header / line-item groups / totals) —
 * never split a line item, it destroys the meaning of its numbers." Pure, no I/O (packages/domain
 * has zero `@retailos/*` dependencies) — the real embedding call and the real database write are
 * the caller's job (`apps/worker`'s chunk-embedding processor), matching `buildDocumentEmbeddingText`
 *'s own precedent one file over in this same directory.
 *
 * **Chunk granularity, decided directly from the spec's own two rules, not guessed**: one HEADER
 * chunk (supplier/documentNumber/date/currency/subtotal/tax/discount/total — everything that
 * describes the document as a whole, never a specific line), and ONE CHUNK PER LINE ITEM (never
 * grouped — "never split a line item" is a floor, not a ceiling; grouping multiple real, distinct
 * line items into one chunk would let a retrieval hit for one line's terms surface a chunk whose
 * embedded text is diluted by unrelated lines, exactly the imprecision structure-aware chunking
 * exists to prevent). A document with zero lines still gets a real header chunk — an invoice with
 * only header data extracted is not "nothing to chunk."
 *
 * **A field with `value: null` (I7 — genuinely unextracted, not just empty) is omitted from a
 * chunk's text entirely** — matching `buildDocumentEmbeddingText`'s own established convention.
 * An omitted fact should not shape what the embedding represents, and a chunk consisting ENTIRELY
 * of omitted fields (every field null) produces no chunk at all rather than an empty, meaningless
 * embedding target.
 */
export type DocumentChunk = {
  /** Stable within one chunking run — `'header'` or `'line-{index}'` (0-based) — so a caller can
   * re-chunk a re-extracted document and know which chunk replaced which. */
  chunkKey: string;
  chunkType: 'header' | 'line_item';
  /** The real, retrievable text this chunk's embedding is built from — never empty (a
   * would-be-empty chunk is filtered out by `chunkDocument`, never returned as a blank string). */
  text: string;
  /** 0-based position among this document's own chunks, for stable ordering in a UI/citation —
   * NOT a global corpus index. */
  order: number;
};

const field = (label: string, f: ExtractedField | undefined): string | null => (f?.value ? `${label}: ${f.value}` : null);

const buildHeaderText = (fields: ExtractedFields): string | null => {
  const parts = [
    field('Supplier', fields.supplier),
    field('Document number', fields.documentNumber),
    field('Date', fields.documentDate),
    field('Currency', fields.currency),
    field('Subtotal', fields.subtotal),
    field('Tax', fields.tax),
    field('Discount', fields.discount),
    field('Total', fields.total),
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join('. ') : null;
};

const buildLineText = (line: ExtractedLine): string | null => {
  const parts = [
    field('Item', line.description),
    field('SKU', line.sku),
    field('Quantity', line.quantity),
    field('Unit', line.unit),
    field('Unit price', line.unitPrice),
    field('Line total', line.lineTotal),
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(', ') : null;
};

export const chunkDocument = (fields: ExtractedFields, lines: ExtractedLine[]): DocumentChunk[] => {
  const chunks: DocumentChunk[] = [];

  const headerText = buildHeaderText(fields);
  if (headerText) {
    chunks.push({ chunkKey: 'header', chunkType: 'header', text: headerText, order: 0 });
  }

  lines.forEach((line, index) => {
    const text = buildLineText(line);
    if (text) {
      chunks.push({ chunkKey: `line-${index}`, chunkType: 'line_item', text, order: chunks.length });
    }
  });

  return chunks;
};
