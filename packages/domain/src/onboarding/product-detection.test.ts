import { describe, expect, it } from 'vitest';
import { clusterUnmappedLines, detectProductCandidates, proposeProductFromCluster, type UnmappedInvoiceLine } from './product-detection';

const line = (overrides: Partial<UnmappedInvoiceLine> = {}): UnmappedInvoiceLine => ({
  documentId: 'doc-1',
  lineIndex: 0,
  supplierSku: null,
  description: 'Flour T55 25kg',
  quantity: '2',
  unit: null,
  unitPrice: '18.00',
  ...overrides,
});

describe('clusterUnmappedLines', () => {
  it('groups lines sharing the exact same real supplierSku into one cluster, regardless of description wording', () => {
    const lines = [
      line({ documentId: 'a', lineIndex: 0, supplierSku: 'FLR-25', description: 'Flour T55 25kg' }),
      line({ documentId: 'b', lineIndex: 0, supplierSku: 'FLR-25', description: 'T55 FLOUR 25KG SACK' }),
    ];
    const clusters = clusterUnmappedLines(lines);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(2);
  });

  it('clusters SKU-less lines by description similarity above threshold', () => {
    const lines = [
      line({ documentId: 'a', lineIndex: 0, supplierSku: null, description: 'Fresh Butter Unsalted 1kg' }),
      line({ documentId: 'b', lineIndex: 0, supplierSku: null, description: 'Unsalted Butter Fresh 1kg' }),
    ];
    const clusters = clusterUnmappedLines(lines);
    expect(clusters).toHaveLength(1);
  });

  it('does NOT merge two genuinely different products into one cluster', () => {
    const lines = [
      line({ documentId: 'a', lineIndex: 0, supplierSku: null, description: 'Fresh Butter Unsalted 1kg' }),
      line({ documentId: 'b', lineIndex: 0, supplierSku: null, description: 'Fresh Yeast 500g' }),
    ];
    const clusters = clusterUnmappedLines(lines);
    expect(clusters).toHaveLength(2);
  });

  it('a distinct supplierSku never merges with an unrelated SKU cluster even with similar text', () => {
    const lines = [
      line({ documentId: 'a', lineIndex: 0, supplierSku: 'BTR-1', description: 'Butter 1kg' }),
      line({ documentId: 'b', lineIndex: 0, supplierSku: 'BTR-2', description: 'Butter 1kg' }),
    ];
    const clusters = clusterUnmappedLines(lines);
    expect(clusters).toHaveLength(2);
  });
});

describe('proposeProductFromCluster', () => {
  it('proposes the longest real description as the name, never a synthesized one', () => {
    const cluster = [
      line({ documentId: 'a', lineIndex: 0, description: 'Flour T55' }),
      line({ documentId: 'b', lineIndex: 0, description: 'Flour T55 25kg Sack' }),
    ];
    const candidate = proposeProductFromCluster(cluster);
    expect(candidate.proposedName).toBe('Flour T55 25kg Sack');
  });

  it('proposes a unit only when every evidence line agrees, read from the unit field first', () => {
    const cluster = [
      line({ documentId: 'a', lineIndex: 0, unit: 'kg', description: 'Flour' }),
      line({ documentId: 'b', lineIndex: 0, unit: 'kg', description: 'Flour' }),
    ];
    const candidate = proposeProductFromCluster(cluster);
    expect(candidate.proposedUnit).toBe('kg');
  });

  it('proposes no unit at all when evidence lines disagree — never guesses one', () => {
    const cluster = [
      line({ documentId: 'a', lineIndex: 0, unit: 'kg', description: 'Flour' }),
      line({ documentId: 'b', lineIndex: 0, unit: 'g', description: 'Flour' }),
    ];
    const candidate = proposeProductFromCluster(cluster);
    expect(candidate.proposedUnit).toBeNull();
  });

  it('proposes no unit when nothing in the field or description names a real unit — never fabricates one', () => {
    const cluster = [line({ documentId: 'a', lineIndex: 0, unit: null, description: 'Assorted pastries' })];
    const candidate = proposeProductFromCluster(cluster);
    expect(candidate.proposedUnit).toBeNull();
  });

  it('reads pack size directly from description text (number immediately followed by a real unit)', () => {
    const cluster = [
      line({ documentId: 'a', lineIndex: 0, description: 'Flour T55 25kg' }),
      line({ documentId: 'b', lineIndex: 0, description: 'Flour T55 25kg' }),
    ];
    const candidate = proposeProductFromCluster(cluster);
    expect(candidate.proposedPackSize).toBe('25');
  });

  it('does NOT derive pack size from the extracted order quantity — that is a different number', () => {
    const cluster = [line({ documentId: 'a', lineIndex: 0, quantity: '3', description: 'Assorted crates' })];
    const candidate = proposeProductFromCluster(cluster);
    expect(candidate.proposedPackSize).toBeNull();
  });

  it('proposes no pack size when evidence lines disagree — a real mixed-size cluster stays honest, not averaged', () => {
    const cluster = [
      line({ documentId: 'a', lineIndex: 0, description: 'T55 Flour 25kg' }),
      line({ documentId: 'b', lineIndex: 0, description: 'T55 Flour 1kg' }),
    ];
    const candidate = proposeProductFromCluster(cluster);
    expect(candidate.proposedPackSize).toBeNull();
  });

  it('carries every real evidence line, unmodified, for a human to actually review', () => {
    const cluster = [
      line({ documentId: 'a', lineIndex: 0 }),
      line({ documentId: 'b', lineIndex: 2 }),
    ];
    const candidate = proposeProductFromCluster(cluster);
    expect(candidate.evidenceLines).toEqual(cluster);
  });

  it('clusterKey is stable and order-independent for the same set of lines', () => {
    const clusterA = [line({ documentId: 'a', lineIndex: 0 }), line({ documentId: 'b', lineIndex: 1 })];
    const clusterB = [line({ documentId: 'b', lineIndex: 1 }), line({ documentId: 'a', lineIndex: 0 })];
    expect(proposeProductFromCluster(clusterA).clusterKey).toBe(proposeProductFromCluster(clusterB).clusterKey);
  });
});

describe('detectProductCandidates', () => {
  it('sorts candidates by evidence count, most-supported first', () => {
    const lines = [
      line({ documentId: 'a', lineIndex: 0, supplierSku: 'ONE', description: 'Single-invoice item' }),
      line({ documentId: 'b', lineIndex: 0, supplierSku: 'MANY', description: 'Repeated item' }),
      line({ documentId: 'c', lineIndex: 0, supplierSku: 'MANY', description: 'Repeated item' }),
      line({ documentId: 'd', lineIndex: 0, supplierSku: 'MANY', description: 'Repeated item' }),
    ];
    const candidates = detectProductCandidates(lines);
    expect(candidates[0]!.evidenceLines).toHaveLength(3);
    expect(candidates[1]!.evidenceLines).toHaveLength(1);
  });

  it('returns an empty list for no input, never a fabricated candidate', () => {
    expect(detectProductCandidates([])).toEqual([]);
  });
});
