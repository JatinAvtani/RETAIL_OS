/**
 * "Deduplication + suppression: same issue within window -> update existing, don't re-send."
 * Confirmed with the user: suppression here is CONDITION-based, not time-based — there is no
 * arbitrary duration to defend or tune. An open (unresolved) notification for a dedup_key stays
 * open and gets updated for as long as the underlying condition keeps re-firing on each
 * evaluation; the moment an evaluation of that same dedup_key no longer fires, the open
 * notification resolves. A later re-occurrence of the same condition then starts a genuinely
 * fresh notification — the DB's partial unique index (`WHERE resolved_at IS NULL`) is exactly what
 * makes "fresh" possible once resolved.
 *
 * This keeps the mechanism simple to reason about and matches how an operator actually thinks
 * about these alerts: "is this still a problem?", not "has N hours passed since I was last told?"
 * A time-based backstop was considered and deliberately deferred — nothing in this codebase's own
 * event pipeline can currently fail to re-evaluate a dedup_key silently (the relay's consumers are
 * driven by real domain events, not a best-effort poll that could stop running unnoticed), so the
 * failure mode a backstop would guard against doesn't yet exist here.
 */

export type DedupAction =
  | { kind: 'CREATE' }
  | { kind: 'UPDATE'; existingId: string }
  | { kind: 'RESOLVE'; existingId: string }
  | { kind: 'NO_OP' };

export interface ExistingOpenNotification {
  id: string;
}

/**
 * The single decision point every rule evaluation's outcome must pass through before touching the
 * database. `fires` is the evaluator's own real answer (`evaluateStockBelowReorder(...).fires`,
 * etc.) — this function adds no detection logic of its own, only decides what a firing/non-firing
 * result means given whatever open notification (if any) already exists for the same dedup_key.
 *
 * - fires + no existing open notification -> CREATE a new one.
 * - fires + an existing open notification -> UPDATE it in place (the DB's partial unique index is
 *   what makes this the ONLY safe outcome for a second INSERT attempt at the same dedup_key while
 *   unresolved — an UPSERT, not a blind INSERT).
 * - does NOT fire + an existing open notification -> RESOLVE it: the condition cleared, so the
 *   record is closed and a future re-occurrence gets a genuinely fresh notification.
 * - does NOT fire + no existing open notification -> NO_OP: nothing to create, nothing to resolve.
 */
export const resolveDedupAction = (fires: boolean, existing: ExistingOpenNotification | null): DedupAction => {
  if (fires) {
    return existing ? { kind: 'UPDATE', existingId: existing.id } : { kind: 'CREATE' };
  }
  return existing ? { kind: 'RESOLVE', existingId: existing.id } : { kind: 'NO_OP' };
};
