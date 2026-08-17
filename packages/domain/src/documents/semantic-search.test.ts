import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildDocumentEmbeddingText, fuseRankedResults, shouldUseHybridSearch, RRF_K } from './semantic-search';

describe('buildDocumentEmbeddingText', () => {
  it('assembles every present field into a real, readable sentence', () => {
    const text = buildDocumentEmbeddingText(
      { supplier: { value: 'Coastal Meats & Poultry' }, documentNumber: { value: 'INV-2024-8891' }, documentDate: { value: '2024-03-01' }, total: { value: '450.00' } },
      [{ description: { value: 'Chicken breast' } }, { description: { value: 'Ground beef' } }]
    );
    expect(text).toBe('Supplier: Coastal Meats & Poultry. Document number: INV-2024-8891. Date: 2024-03-01. Total: 450.00. Line items: Chicken breast, Ground beef');
  });

  it('a field with value: null (genuinely unextracted, I7) is omitted entirely, never rendered as the string "null"', () => {
    const text = buildDocumentEmbeddingText({ supplier: { value: 'Acme' }, documentNumber: { value: null } }, []);
    expect(text).toBe('Supplier: Acme');
    expect(text).not.toContain('null');
  });

  it('a completely empty extraction produces an empty string, never a placeholder', () => {
    const text = buildDocumentEmbeddingText({}, []);
    expect(text).toBe('');
  });

  it('line items with no description value are filtered out, never contributing an empty entry', () => {
    const text = buildDocumentEmbeddingText({}, [{ description: { value: 'Flour' } }, { description: { value: null } }, {}]);
    expect(text).toBe('Line items: Flour');
  });
});

describe('fuseRankedResults', () => {
  it('a result appearing in both lists scores the sum of both reciprocal ranks', () => {
    const fused = fuseRankedResults([
      [{ id: 'a', rank: 1 }],
      [{ id: 'a', rank: 1 }],
    ]);
    expect(fused[0]!.score).toBeCloseTo(2 / (RRF_K + 1), 10);
  });

  it('a result appearing in only one list still gets a real score from that list alone', () => {
    const fused = fuseRankedResults([
      [{ id: 'a', rank: 1 }],
      [{ id: 'b', rank: 1 }],
    ]);
    const a = fused.find((r) => r.id === 'a')!;
    const b = fused.find((r) => r.id === 'b')!;
    expect(a.score).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(b.score).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  it('a lower rank (closer to the top) always produces a higher fused score than a higher rank in the same list', () => {
    const fused = fuseRankedResults([[{ id: 'top', rank: 1 }, { id: 'bottom', rank: 50 }]]);
    const top = fused.find((r) => r.id === 'top')!;
    const bottom = fused.find((r) => r.id === 'bottom')!;
    expect(top.score).toBeGreaterThan(bottom.score);
  });

  it('results are sorted by descending fused score', () => {
    const fused = fuseRankedResults([[{ id: 'a', rank: 5 }, { id: 'b', rank: 1 }, { id: 'c', rank: 3 }]]);
    expect(fused.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('an empty input produces an empty result, not an error', () => {
    expect(fuseRankedResults([])).toEqual([]);
    expect(fuseRankedResults([[], []])).toEqual([]);
  });

  it('property: every fused score is always positive and finite, for any real rank list', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.record({ id: fc.string({ minLength: 1 }), rank: fc.integer({ min: 1, max: 1000 }) }), { maxLength: 10 }), { maxLength: 5 }),
        (lists) => {
          const fused = fuseRankedResults(lists);
          return fused.every((r) => Number.isFinite(r.score) && r.score > 0);
        }
      )
    );
  });
});

describe('shouldUseHybridSearch', () => {
  it('a short query (<=4 words) stays lexical-only, even if question-like', () => {
    expect(shouldUseHybridSearch('what is flour')).toBe(false);
  });

  it('an identifier-like short query stays lexical-only', () => {
    expect(shouldUseHybridSearch('INV-2024-8891')).toBe(false);
  });

  it('a long natural-language question routes to hybrid', () => {
    expect(shouldUseHybridSearch('which invoices mention flour price increases this month')).toBe(true);
  });

  it('a long query ending in a question mark routes to hybrid, even without a leading interrogative word', () => {
    expect(shouldUseHybridSearch('did the supplier ever raise beef prices?')).toBe(true);
  });

  it('a long query with no question mark and no interrogative word stays lexical-only', () => {
    expect(shouldUseHybridSearch('coastal meats poultry march april invoices')).toBe(false);
  });
});
