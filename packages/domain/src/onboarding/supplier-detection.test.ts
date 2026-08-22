import { describe, expect, it } from 'vitest';
import {
  clusterUnmappedSupplierMentions,
  detectSupplierCandidates,
  proposeSupplierFromCluster,
  type UnmappedSupplierMention,
} from './supplier-detection';

const mention = (overrides: Partial<UnmappedSupplierMention> = {}): UnmappedSupplierMention => ({
  documentId: 'doc-1',
  supplierName: 'Nova Foods',
  ...overrides,
});

describe('clusterUnmappedSupplierMentions', () => {
  it('clusters mentions with similar real names together', () => {
    const mentions = [
      mention({ documentId: 'a', supplierName: 'Nova Foods' }),
      mention({ documentId: 'b', supplierName: 'Nova Foods Ltd' }),
    ];
    const clusters = clusterUnmappedSupplierMentions(mentions);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(2);
  });

  it('does NOT merge two genuinely different supplier names into one cluster', () => {
    const mentions = [
      mention({ documentId: 'a', supplierName: 'Nova Foods' }),
      mention({ documentId: 'b', supplierName: 'Aurora Dairy' }),
    ];
    const clusters = clusterUnmappedSupplierMentions(mentions);
    expect(clusters).toHaveLength(2);
  });

  it('handles a single mention as its own one-item cluster', () => {
    const clusters = clusterUnmappedSupplierMentions([mention()]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(1);
  });
});

describe('proposeSupplierFromCluster', () => {
  it('proposes the most frequently occurring real spelling, never a synthesized/normalized name', () => {
    const cluster = [
      mention({ documentId: 'a', supplierName: 'Nova Foods Ltd' }),
      mention({ documentId: 'b', supplierName: 'Nova Foods' }),
      mention({ documentId: 'c', supplierName: 'Nova Foods' }),
    ];
    const candidate = proposeSupplierFromCluster(cluster);
    expect(candidate.proposedName).toBe('Nova Foods');
  });

  it('carries every real evidence document id, sorted, never fabricated', () => {
    const cluster = [
      mention({ documentId: 'c', supplierName: 'Nova Foods' }),
      mention({ documentId: 'a', supplierName: 'Nova Foods' }),
    ];
    const candidate = proposeSupplierFromCluster(cluster);
    expect(candidate.evidenceDocumentIds).toEqual(['a', 'c']);
  });

  it('clusterKey is stable and order-independent for the same set of mentions', () => {
    const clusterA = [mention({ documentId: 'a' }), mention({ documentId: 'b' })];
    const clusterB = [mention({ documentId: 'b' }), mention({ documentId: 'a' })];
    expect(proposeSupplierFromCluster(clusterA).clusterKey).toBe(proposeSupplierFromCluster(clusterB).clusterKey);
  });
});

describe('detectSupplierCandidates', () => {
  it('sorts candidates by evidence count, most-supported first', () => {
    const mentions = [
      mention({ documentId: 'a', supplierName: 'Single Invoice Co' }),
      mention({ documentId: 'b', supplierName: 'Repeated Supplier' }),
      mention({ documentId: 'c', supplierName: 'Repeated Supplier' }),
      mention({ documentId: 'd', supplierName: 'Repeated Supplier' }),
    ];
    const candidates = detectSupplierCandidates(mentions);
    expect(candidates[0]!.evidenceDocumentIds).toHaveLength(3);
    expect(candidates[1]!.evidenceDocumentIds).toHaveLength(1);
  });

  it('returns an empty list for no input, never a fabricated candidate', () => {
    expect(detectSupplierCandidates([])).toEqual([]);
  });
});
