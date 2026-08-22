/**
 * 012-03: "group extracted invoice lines by (supplier_sku, normalised description) → cluster
 * near-duplicates → infer name, pack size, unit → propose one product per cluster, with evidence
 * lines attached → human confirms in bulk" (plan.md, this epic's own worked example).
 *
 * Pure, no I/O — given the raw extracted lines a caller has already determined have NO confirmed
 * supplier_products mapping yet, groups them into clusters (one real or proposed product per
 * cluster) and proposes a name/quantity for each. Every inferred field is either read verbatim
 * from real invoice text or left `null` — never guessed (I7). This module NEVER writes anything;
 * confirming a proposal into a real product + supplier_products mapping is 012-05's separate,
 * human-gated scope (I9).
 */

const REAL_UNIT_CODES = ['kg', 'g', 'l', 'ml', 'each', 'mg'] as const;
export type RealUnitCode = (typeof REAL_UNIT_CODES)[number];

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Same token-overlap scorer `suggestMenuItemMatches` (packages/domain/src/sales/menu-item-match.ts)
 * already established for the analogous "human confirms a fuzzy suggestion" shape — reused
 * verbatim (I2), not reimplemented, since the underlying question ("how similar are these two free
 * text strings") is identical.
 */
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

/** Two descriptions are treated as the same real-world product above this token-overlap score. */
const CLUSTER_SIMILARITY_THRESHOLD = 0.5;

export type UnmappedInvoiceLine = {
  documentId: string;
  lineIndex: number;
  supplierSku: string | null;
  description: string;
  quantity: string | null;
  unit: string | null;
  unitPrice: string | null;
};

export type DetectedProductCandidate = {
  /** Stable within one detection run — not a real id, since nothing is written yet. */
  clusterKey: string;
  /** The longest real description in the cluster — never a synthesized/templated name (I7). */
  proposedName: string;
  /** Only set when a real unit code appears verbatim in at least one line's own `unit` field or description text — never guessed from the product category. */
  proposedUnit: RealUnitCode | null;
  /** Only set when a real numeric pack size can be read directly from a line's own extracted quantity/description — never defaulted to 1 or averaged across a mismatched cluster. */
  proposedPackSize: string | null;
  evidenceLines: UnmappedInvoiceLine[];
};

/**
 * Reads a real unit code straight out of a line's own extracted `unit` field, falling back to
 * scanning `description` for one of the real, finite unit-vocabulary tokens as a whole word — this
 * app's global `units` table has exactly 6 real codes (confirmed against the live catalog before
 * writing this), so matching against that closed list can never propose a unit that doesn't exist.
 */
const detectUnit = (line: UnmappedInvoiceLine): RealUnitCode | null => {
  const fromField = line.unit?.trim().toLowerCase();
  if (fromField && (REAL_UNIT_CODES as readonly string[]).includes(fromField)) {
    return fromField as RealUnitCode;
  }
  const words = normalize(line.description).split(' ');
  for (const code of REAL_UNIT_CODES) {
    if (words.includes(code)) return code;
  }
  return null;
};

/**
 * Every real evidence line's own extracted `quantity` is a per-shipment order quantity, NOT a
 * product's pack size — those are different numbers (ordering 3 cases of a 25kg sack has quantity
 * 3, pack size 25kg). Pack size is only trustworthy when read directly from the description text
 * itself (a number immediately followed by a real unit token, e.g. "25kg", "25 kg") — never derived
 * from `quantity`, which would silently conflate the two.
 */
const detectPackSize = (description: string): string | null => {
  const match = normalize(description).match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml|mg|each)\b/);
  return match ? match[1]! : null;
};

/**
 * Deterministic grouping first: lines sharing the exact same non-null `supplierSku` are always one
 * cluster — a real SKU is the strongest possible signal, stronger than any text similarity. Lines
 * with no SKU (or a SKU unique to just that line) fall back to description-similarity clustering,
 * greedy single-pass (each line joins the first existing cluster it scores above threshold against,
 * else starts a new one) — matches this codebase's own "good enough starting point for a human to
 * confirm, not an optimal clustering algorithm" precedent (see menu-item-match.ts's own doc
 * comment).
 */
export const clusterUnmappedLines = (lines: UnmappedInvoiceLine[]): UnmappedInvoiceLine[][] => {
  const bySku = new Map<string, UnmappedInvoiceLine[]>();
  const noSku: UnmappedInvoiceLine[] = [];

  for (const line of lines) {
    if (line.supplierSku) {
      const existing = bySku.get(line.supplierSku);
      if (existing) existing.push(line);
      else bySku.set(line.supplierSku, [line]);
    } else {
      noSku.push(line);
    }
  }

  const clusters: UnmappedInvoiceLine[][] = [...bySku.values()];

  for (const line of noSku) {
    const match = clusters.find((cluster) => {
      const representative = cluster[0];
      return representative ? similarityScore(line.description, representative.description) >= CLUSTER_SIMILARITY_THRESHOLD : false;
    });
    if (match) match.push(line);
    else clusters.push([line]);
  }

  return clusters;
};

/** The longest description in a cluster is treated as the most descriptive/complete real text — never a synthesized or truncated name. */
const proposeName = (cluster: UnmappedInvoiceLine[]): string =>
  cluster.reduce((longest, line) => (line.description.length > longest.length ? line.description : longest), cluster[0]!.description);

/**
 * Unit/pack-size are only proposed when every evidence line in the cluster AGREES — a cluster
 * mixing "T55 Flour 25kg" and "T55 Flour 1kg" (a real, plausible near-duplicate description match)
 * must not silently pick one pack size and discard the other; both are genuinely different
 * products masquerading as one cluster, which a human reviewing evidence lines needs to catch, not
 * have hidden by an averaged or first-wins value (I7).
 */
export const proposeProductFromCluster = (cluster: UnmappedInvoiceLine[]): DetectedProductCandidate => {
  const clusterKey = cluster
    .map((line) => `${line.documentId}:${line.lineIndex}`)
    .sort()
    .join('|');

  const units = new Set(cluster.map(detectUnit).filter((u): u is RealUnitCode => u !== null));
  const proposedUnit = units.size === 1 ? [...units][0]! : null;

  const packSizes = new Set(cluster.map((line) => detectPackSize(line.description)).filter((p): p is string => p !== null));
  const proposedPackSize = packSizes.size === 1 ? [...packSizes][0]! : null;

  return {
    clusterKey,
    proposedName: proposeName(cluster),
    proposedUnit,
    proposedPackSize,
    evidenceLines: cluster,
  };
};

/** The real entry point: clusters, then proposes one candidate per cluster, sorted by evidence count (most-supported first — the highest-confidence proposals for a reviewer to see first). */
export const detectProductCandidates = (lines: UnmappedInvoiceLine[]): DetectedProductCandidate[] =>
  clusterUnmappedLines(lines)
    .map(proposeProductFromCluster)
    .sort((a, b) => b.evidenceLines.length - a.evidenceLines.length);
