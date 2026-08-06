/**
 * 006-11 (plan.md Phase 6): "fuzzy-suggest a menu item by name similarity; the human confirms."
 * Deliberately NOT real trigram/Levenshtein similarity — matching `products.list`'s own precedent
 * of deferring real pg_trgm search until there's enough volume to need it (see that router's doc
 * comment). A confirmed mapping is permanent and human-decided either way (I9), so the suggestion
 * only has to be a good enough starting point, not a scored ranking algorithm.
 *
 * Pure, no I/O — given a POS item name and the full list of candidate menu items, returns menu
 * items sorted by how closely their normalized name matches, best first. Never auto-selects
 * anything; the caller always presents this as suggestions for a human to confirm or reject.
 */

const normalize = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * 0 = no similarity, 1 = normalized names are identical. Token-overlap based (shared words /
 * total distinct words across both names) — cheap, deterministic, and unlike substring matching
 * alone, handles word-order differences ("Iced Latte" vs "Latte, Iced") the same way.
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

export type MenuItemMatchCandidate = { id: string; name: string };
export type MenuItemMatchSuggestion = { menuItemId: string; name: string; score: number };

/**
 * Returns every candidate with a nonzero score, sorted best-match first. Caller decides how many
 * to actually show (plan.md doesn't specify a cutoff) — this function makes no UI decision about
 * "top N", it only ranks.
 */
export const suggestMenuItemMatches = (
  posItemName: string,
  candidates: MenuItemMatchCandidate[]
): MenuItemMatchSuggestion[] =>
  candidates
    .map((candidate) => ({ menuItemId: candidate.id, name: candidate.name, score: similarityScore(posItemName, candidate.name) }))
    .filter((suggestion) => suggestion.score > 0)
    .sort((a, b) => b.score - a.score);
