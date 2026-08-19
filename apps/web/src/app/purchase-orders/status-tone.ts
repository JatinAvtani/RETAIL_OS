import type { BadgeTone } from '@/components/ui';

export type PurchaseOrderStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SENT'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'CLOSED'
  | 'CANCELLED';

/**
 * One shared status → badge-tone mapping for every purchase-order surface (list, detail), so the
 * same status can never wear two different colours on two screens. Rejection is deliberately NOT
 * a distinct tone: REJECTED is an annotation on a DRAFT row (`rejectedAt`/`rejectionReason`), not
 * a new terminal state, matching the domain state machine exactly.
 */
export const statusTone = (status: PurchaseOrderStatus): BadgeTone => {
  if (status === 'RECEIVED' || status === 'CLOSED') return 'positive';
  if (status === 'CANCELLED') return 'danger';
  if (status === 'PENDING_APPROVAL') return 'warning';
  if (status === 'APPROVED' || status === 'SENT' || status === 'PARTIALLY_RECEIVED') return 'accent';
  return 'neutral';
};

/** `PENDING_APPROVAL` → `Pending approval` — statuses render as words, not enum constants. */
export const statusLabel = (status: PurchaseOrderStatus): string => {
  const words = status.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
