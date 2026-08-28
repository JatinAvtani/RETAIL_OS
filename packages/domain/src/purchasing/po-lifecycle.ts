/**
 * the design's exact state diagram:
 *
 *   DRAFT --submit--> PENDING_APPROVAL --approve--> APPROVED --send--> SENT
 *                            |                                          |
 *                         reject                                 receive(partial)
 *                            v                                          v
 *                      DRAFT/CANCELLED                        PARTIALLY_RECEIVED
 *                                                                    |       |
 *                                                          receive(rest)  close_short
 *                                                                    v       v
 *                                                                RECEIVED  CLOSED
 *                                                                    |
 *                                                                 close
 *                                                                    v
 *                                                                CLOSED
 *   (CANCELLED reachable from DRAFT, PENDING_APPROVAL, APPROVED, SENT)
 *
 * `PARTIALLY_RECEIVED --close_short--> CLOSED` is an addition beyond the design's original literal
 * diagram, not a spec deviation to the RECEIVE/CANCEL semantics: the design showed
 * `RECEIVED --> CLOSED` but drew no exit at all from `PARTIALLY_RECEIVED` other than receiving the
 * rest — meaning a supplier who short-ships and never delivers the remaining balance (the single
 * most common real purchasing outcome) left the PO stuck in `PARTIALLY_RECEIVED` forever, the one
 * state with no way out. `CLOSE_SHORT` is deliberately NOT `CANCEL` — see that field's own comment.
 *
 * A pure function, not scattered `if (status ===...)` checks in repository/route code — the same
 * discipline `decideDocumentRouting` (packages/domain/src/documents/routing.ts) established: an
 * invalid transition is rejected explicitly here, once, rather than silently ignored or re-derived
 * differently at each call site. The database's `purchase_order_status` enum only constrains which
 * VALUES exist; this function is the single source of truth for which SEQUENCES are legal.
 */

export type PurchaseOrderStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SENT'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'CLOSED'
  | 'CANCELLED';

export type PurchaseOrderEvent = 'SUBMIT' | 'APPROVE' | 'REJECT' | 'SEND' | 'RECEIVE_PARTIAL' | 'RECEIVE_FULL' | 'CANCEL' | 'CLOSE_SHORT';

export type PoTransitionResult =
  | { readonly allowed: true; readonly nextStatus: PurchaseOrderStatus }
  | { readonly allowed: false; readonly reason: string };

/**
 * `REJECT` from `PENDING_APPROVAL` returns to `DRAFT` — the design's diagram literally shows
 * "DRAFT/CANCELLED" as the reject target, meaning a rejection is a correctable draft state by
 * default (a manager can revise and resubmit), not an automatic dead end. Rejecting all the way to
 * `CANCELLED` is a separate, explicit `CANCEL` event from any pre-terminal state — never implied by
 * `REJECT` alone, so "sent back for revision" and "abandoned" stay distinguishable in the data.
 */
const TRANSITIONS: Record<PurchaseOrderStatus, Partial<Record<PurchaseOrderEvent, PurchaseOrderStatus>>> = {
  DRAFT: {
    SUBMIT: 'PENDING_APPROVAL',
    CANCEL: 'CANCELLED',
  },
  PENDING_APPROVAL: {
    APPROVE: 'APPROVED',
    REJECT: 'DRAFT',
    CANCEL: 'CANCELLED',
  },
  APPROVED: {
    SEND: 'SENT',
    CANCEL: 'CANCELLED',
  },
  SENT: {
    RECEIVE_PARTIAL: 'PARTIALLY_RECEIVED',
    RECEIVE_FULL: 'RECEIVED',
    CANCEL: 'CANCELLED',
  },
  PARTIALLY_RECEIVED: {
    RECEIVE_PARTIAL: 'PARTIALLY_RECEIVED',
    RECEIVE_FULL: 'RECEIVED',
    // Deliberately NOT `CANCEL: 'CANCELLED'` — real goods have already arrived and been posted as
    // real stock via RECEIVE_PARTIAL, so "cancelled" would misdescribe an order that partly,
    // genuinely happened (this is the existing, deliberate reasoning the diagram/tests already
    // encode: "once physical goods have arrived, cancelling the order is meaningless"). But the
    // most common real purchasing outcome — a supplier short-ships and never delivers the
    // remaining balance — used to leave a PO stuck HERE permanently: every other pre-terminal
    // state has SOME exit, this one had none, with no legal transition out short of a manual DB
    // fix. CLOSE_SHORT is a real, honestly-named exit: "stop expecting the rest, keep what
    // arrived" — administratively closed, not cancelled.
    CLOSE_SHORT: 'CLOSED',
  },
  RECEIVED: {},
  CLOSED: {},
  CANCELLED: {},
};

/**
 * Every state this event can validly fire FROM — the single source `canTransition`/`applyTransition`
 * both derive from, so the "is this legal" check and the "what state does it produce" answer can
 * never silently disagree with each other.
 */
export const applyPurchaseOrderTransition = (
  currentStatus: PurchaseOrderStatus,
  event: PurchaseOrderEvent
): PoTransitionResult => {
  const nextStatus = TRANSITIONS[currentStatus][event];
  if (nextStatus === undefined) {
    return {
      allowed: false,
      reason: `Cannot apply ${event} to a purchase order in ${currentStatus} status.`,
    };
  }
  return { allowed: true, nextStatus };
};

export const canTransitionPurchaseOrder = (currentStatus: PurchaseOrderStatus, event: PurchaseOrderEvent): boolean =>
  applyPurchaseOrderTransition(currentStatus, event).allowed;

/**
 * `RECEIVED --> CLOSED` (spec's diagram) is not modeled as a domain EVENT here — closing is an
 * administrative/manual action (e.g. after invoice reconciliation, earlier work's three-way match) with
 * no receiving-flow trigger of its own yet. Exposed as a direct check rather than forcing a
 * placeholder `CLOSE` event through `applyPurchaseOrderTransition` before there's a real caller —
 * matches this project's standing discipline of not building unused abstraction ahead of a real need.
 */
export const canClosePurchaseOrder = (currentStatus: PurchaseOrderStatus): boolean => currentStatus === 'RECEIVED';

/**
 * the design: "SENT triggers PDF generation + email to the supplier contact, and the PO
 * becomes immutable." Immutability begins exactly AT `SENT`, not any earlier state —
 * `DRAFT`/`PENDING_APPROVAL`/`APPROVED` are all still freely editable; only `SENT` and every state
 * reachable from it (`PARTIALLY_RECEIVED`, `RECEIVED`, `CLOSED`) are locked. `CANCELLED` is also
 * immutable (nothing legitimately edits a cancelled order), included explicitly rather than
 * derived from "not DRAFT/PENDING_APPROVAL/APPROVED" so a future new status added to the enum
 * fails closed (must be added here deliberately) instead of silently becoming mutable by omission.
 */
export const isPurchaseOrderImmutable = (status: PurchaseOrderStatus): boolean =>
  status === 'SENT' ||
  status === 'PARTIALLY_RECEIVED' ||
  status === 'RECEIVED' ||
  status === 'CLOSED' ||
  status === 'CANCELLED';

/** Terminal states nothing further can happen to. */
export const isPurchaseOrderTerminal = (status: PurchaseOrderStatus): boolean =>
  status === 'CLOSED' || status === 'CANCELLED';
