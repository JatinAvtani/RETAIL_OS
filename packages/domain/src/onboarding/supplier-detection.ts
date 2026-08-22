/**
 * 012-04: "cluster by name similarity + tax ID + address, propose one supplier per cluster, with
 * observed lead times where derivable (order date → delivery date)" (plan.md).
 *
 * Real, confirmed scope narrowing (asked and confirmed before writing this file): `suppliers` has
 * no `taxId`/`address` column, and invoice extraction (`ExtractedFields`, packages/ai) only
 * captures a single `documentDate` — no separate order-date/delivery-date pair exists anywhere in
 * this schema. Tax ID, address, and observed-lead-time detection are therefore unbuildable from
 * real data today. This module clusters by NAME SIMILARITY ONLY and proposes one candidate per
 * cluster with real evidence documents attached — never a fabricated tax ID, address, or lead time
 * (I7). Same "detect and propose only, never write" contract as `product-detection.ts` (I9) —
 * confirming a proposal into a real `suppliers` row remains 012-05's separate, human-gated scope.
 */

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Same token-overlap scorer `product-detection.ts`/`sales/menu-item-match.ts` already establish (I2) — the underlying question ("how similar are two free-text names") is identical here. */
const similarityScore = (a: string, b: string): number => {
  const normalizedA = normalize(a);
  const normalizedB = normalize(b);
  if (normalizedA.length === 0 || normalizedB.length === 0) return 0;
  if (normalizedA === normalizedB) return 1;

  const tokensA = new Set(normalizedA.split(' '));
  const tokensB = new Set(normalizedB.split(' '));
  const shared = [...tokensA].filter((token) => tokensB.has(token)).length;
  const totalDistinct = new Set([...tokensA, ...tokensB]).size;
  const tokenScore = totalDistinct === 0 ? 0 : shared / totalDistinct;

  const substringBonus = normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA) ? 0.2 : 0;

  return Math.min(1, tokenScore + substringBonus);
};

const CLUSTER_SIMILARITY_THRESHOLD = 0.5;

export type UnmappedSupplierMention = {
  documentId: string;
  /** The real, verbatim string extracted from `fields.supplier.value` for this document. */
  supplierName: string;
};

export type DetectedSupplierCandidate = {
  /** Stable within one detection run — not a real id, since nothing is written yet. */
  clusterKey: string;
  /** The most frequent real name spelling in the cluster — never a synthesized/normalized name (I7). */
  proposedName: string;
  /** The real document ids this proposal is evidenced by — a reviewer's only way to check the work. */
  evidenceDocumentIds: string[];
};

/**
 * Greedy single-pass clustering — an unmapped supplier mention joins the first existing cluster its
 * name scores above threshold against, else starts a new one. Same "good enough starting point for
 * a human to confirm, not an optimal clustering algorithm" precedent as `product-detection.ts`'s own
 * `clusterUnmappedLines` and `menu-item-match.ts`.
 */
export const clusterUnmappedSupplierMentions = (mentions: UnmappedSupplierMention[]): UnmappedSupplierMention[][] => {
  const clusters: UnmappedSupplierMention[][] = [];

  for (const mention of mentions) {
    const match = clusters.find((cluster) => {
      const representative = cluster[0];
      return representative ? similarityScore(mention.supplierName, representative.supplierName) >= CLUSTER_SIMILARITY_THRESHOLD : false;
    });
    if (match) match.push(mention);
    else clusters.push([mention]);
  }

  return clusters;
};

/** The most frequently occurring real spelling in the cluster — ties broken by first occurrence, never averaged or synthesized. */
const proposeName = (cluster: UnmappedSupplierMention[]): string => {
  const counts = new Map<string, number>();
  for (const mention of cluster) {
    counts.set(mention.supplierName, (counts.get(mention.supplierName) ?? 0) + 1);
  }
  let best = cluster[0]!.supplierName;
  let bestCount = 0;
  for (const mention of cluster) {
    const count = counts.get(mention.supplierName)!;
    if (count > bestCount) {
      bestCount = count;
      best = mention.supplierName;
    }
  }
  return best;
};

export const proposeSupplierFromCluster = (cluster: UnmappedSupplierMention[]): DetectedSupplierCandidate => {
  const evidenceDocumentIds = cluster.map((mention) => mention.documentId).sort();
  return {
    clusterKey: evidenceDocumentIds.join('|'),
    proposedName: proposeName(cluster),
    evidenceDocumentIds,
  };
};

/** The real entry point: clusters, then proposes one candidate per cluster, sorted by evidence count (most-supported first). */
export const detectSupplierCandidates = (mentions: UnmappedSupplierMention[]): DetectedSupplierCandidate[] =>
  clusterUnmappedSupplierMentions(mentions)
    .map(proposeSupplierFromCluster)
    .sort((a, b) => b.evidenceDocumentIds.length - a.evidenceDocumentIds.length);
