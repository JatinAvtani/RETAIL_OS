import { describe, expect, it } from 'vitest';
import {
  applyPurchaseOrderTransition,
  canTransitionPurchaseOrder,
  canClosePurchaseOrder,
  isPurchaseOrderImmutable,
  isPurchaseOrderTerminal,
  type PurchaseOrderStatus,
  type PurchaseOrderEvent,
} from './po-lifecycle';

const ALL_STATUSES: PurchaseOrderStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SENT',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'CANCELLED',
];

const ALL_EVENTS: PurchaseOrderEvent[] = ['SUBMIT', 'APPROVE', 'REJECT', 'SEND', 'RECEIVE_PARTIAL', 'RECEIVE_FULL', 'CANCEL'];

describe('applyPurchaseOrderTransition — every legal transition from spec 05 §5.2.2\'s diagram', () => {
  it('DRAFT --submit--> PENDING_APPROVAL', () => {
    expect(applyPurchaseOrderTransition('DRAFT', 'SUBMIT')).toEqual({ allowed: true, nextStatus: 'PENDING_APPROVAL' });
  });

  it('PENDING_APPROVAL --approve--> APPROVED', () => {
    expect(applyPurchaseOrderTransition('PENDING_APPROVAL', 'APPROVE')).toEqual({ allowed: true, nextStatus: 'APPROVED' });
  });

  it('PENDING_APPROVAL --reject--> DRAFT (the diagram\'s literal reject target)', () => {
    expect(applyPurchaseOrderTransition('PENDING_APPROVAL', 'REJECT')).toEqual({ allowed: true, nextStatus: 'DRAFT' });
  });

  it('APPROVED --send--> SENT', () => {
    expect(applyPurchaseOrderTransition('APPROVED', 'SEND')).toEqual({ allowed: true, nextStatus: 'SENT' });
  });

  it('SENT --receive(partial)--> PARTIALLY_RECEIVED', () => {
    expect(applyPurchaseOrderTransition('SENT', 'RECEIVE_PARTIAL')).toEqual({ allowed: true, nextStatus: 'PARTIALLY_RECEIVED' });
  });

  it('SENT --receive(full)--> RECEIVED directly (a single delivery can fulfil the whole order at once)', () => {
    expect(applyPurchaseOrderTransition('SENT', 'RECEIVE_FULL')).toEqual({ allowed: true, nextStatus: 'RECEIVED' });
  });

  it('PARTIALLY_RECEIVED --receive(rest)--> RECEIVED', () => {
    expect(applyPurchaseOrderTransition('PARTIALLY_RECEIVED', 'RECEIVE_FULL')).toEqual({ allowed: true, nextStatus: 'RECEIVED' });
  });

  it('PARTIALLY_RECEIVED --receive(partial)--> PARTIALLY_RECEIVED (a second partial delivery)', () => {
    expect(applyPurchaseOrderTransition('PARTIALLY_RECEIVED', 'RECEIVE_PARTIAL')).toEqual({ allowed: true, nextStatus: 'PARTIALLY_RECEIVED' });
  });

  it('CANCEL is reachable from DRAFT, PENDING_APPROVAL, APPROVED, SENT — the diagram\'s explicit list', () => {
    expect(applyPurchaseOrderTransition('DRAFT', 'CANCEL')).toEqual({ allowed: true, nextStatus: 'CANCELLED' });
    expect(applyPurchaseOrderTransition('PENDING_APPROVAL', 'CANCEL')).toEqual({ allowed: true, nextStatus: 'CANCELLED' });
    expect(applyPurchaseOrderTransition('APPROVED', 'CANCEL')).toEqual({ allowed: true, nextStatus: 'CANCELLED' });
    expect(applyPurchaseOrderTransition('SENT', 'CANCEL')).toEqual({ allowed: true, nextStatus: 'CANCELLED' });
  });
});

describe('applyPurchaseOrderTransition — illegal transitions are rejected, not silently ignored', () => {
  it('CANCEL is NOT reachable from PARTIALLY_RECEIVED (once physical goods have arrived, cancelling the order is meaningless)', () => {
    const result = applyPurchaseOrderTransition('PARTIALLY_RECEIVED', 'CANCEL');
    expect(result.allowed).toBe(false);
  });

  it('CANCEL is NOT reachable from RECEIVED or CLOSED (terminal states)', () => {
    expect(applyPurchaseOrderTransition('RECEIVED', 'CANCEL').allowed).toBe(false);
    expect(applyPurchaseOrderTransition('CLOSED', 'CANCEL').allowed).toBe(false);
  });

  it('cannot SUBMIT a PO that is not in DRAFT', () => {
    for (const status of ALL_STATUSES) {
      if (status === 'DRAFT') continue;
      expect(canTransitionPurchaseOrder(status, 'SUBMIT')).toBe(false);
    }
  });

  it('cannot SEND a PO that has not been APPROVED', () => {
    for (const status of ALL_STATUSES) {
      if (status === 'APPROVED') continue;
      expect(canTransitionPurchaseOrder(status, 'SEND')).toBe(false);
    }
  });

  it('cannot RECEIVE anything before a PO has been SENT', () => {
    expect(canTransitionPurchaseOrder('DRAFT', 'RECEIVE_PARTIAL')).toBe(false);
    expect(canTransitionPurchaseOrder('APPROVED', 'RECEIVE_FULL')).toBe(false);
  });

  it('a rejected/invalid transition carries a plain-language reason, not a bare boolean', () => {
    const result = applyPurchaseOrderTransition('CLOSED', 'SUBMIT');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/CLOSED/);
      expect(result.reason).toMatch(/SUBMIT/);
    }
  });

  it('RECEIVED and CLOSED accept no events at all — every one of the 7 named events is rejected', () => {
    for (const event of ALL_EVENTS) {
      expect(canTransitionPurchaseOrder('RECEIVED', event)).toBe(false);
      expect(canTransitionPurchaseOrder('CLOSED', event)).toBe(false);
    }
  });

  it('CANCELLED accepts no events at all — a terminal dead end, no resurrection path', () => {
    for (const event of ALL_EVENTS) {
      expect(canTransitionPurchaseOrder('CANCELLED', event)).toBe(false);
    }
  });
});

describe('isPurchaseOrderImmutable — immutability begins exactly at SENT (spec 05 §5.2.2)', () => {
  it('DRAFT, PENDING_APPROVAL, and APPROVED are all still mutable', () => {
    expect(isPurchaseOrderImmutable('DRAFT')).toBe(false);
    expect(isPurchaseOrderImmutable('PENDING_APPROVAL')).toBe(false);
    expect(isPurchaseOrderImmutable('APPROVED')).toBe(false);
  });

  it('SENT and everything reachable from it are immutable', () => {
    expect(isPurchaseOrderImmutable('SENT')).toBe(true);
    expect(isPurchaseOrderImmutable('PARTIALLY_RECEIVED')).toBe(true);
    expect(isPurchaseOrderImmutable('RECEIVED')).toBe(true);
    expect(isPurchaseOrderImmutable('CLOSED')).toBe(true);
  });

  it('CANCELLED is also immutable', () => {
    expect(isPurchaseOrderImmutable('CANCELLED')).toBe(true);
  });

  it('every status is classified — no status is neither mutable nor immutable', () => {
    for (const status of ALL_STATUSES) {
      expect(typeof isPurchaseOrderImmutable(status)).toBe('boolean');
    }
  });
});

describe('isPurchaseOrderTerminal', () => {
  it('CLOSED and CANCELLED are terminal', () => {
    expect(isPurchaseOrderTerminal('CLOSED')).toBe(true);
    expect(isPurchaseOrderTerminal('CANCELLED')).toBe(true);
  });

  it('every other status is not terminal', () => {
    for (const status of ALL_STATUSES) {
      if (status === 'CLOSED' || status === 'CANCELLED') continue;
      expect(isPurchaseOrderTerminal(status)).toBe(false);
    }
  });
});

describe('canClosePurchaseOrder — spec\'s RECEIVED --> CLOSED, a manual action not modeled as an event', () => {
  it('only RECEIVED can close', () => {
    for (const status of ALL_STATUSES) {
      expect(canClosePurchaseOrder(status)).toBe(status === 'RECEIVED');
    }
  });
});

describe('exhaustive transition table — every (status, event) pair is either legal or explicitly rejected', () => {
  it('applyPurchaseOrderTransition never throws for any combination', () => {
    for (const status of ALL_STATUSES) {
      for (const event of ALL_EVENTS) {
        expect(() => applyPurchaseOrderTransition(status, event)).not.toThrow();
      }
    }
  });

  it('canTransitionPurchaseOrder and applyPurchaseOrderTransition never disagree', () => {
    for (const status of ALL_STATUSES) {
      for (const event of ALL_EVENTS) {
        const canResult = canTransitionPurchaseOrder(status, event);
        const applyResult = applyPurchaseOrderTransition(status, event);
        expect(canResult).toBe(applyResult.allowed);
      }
    }
  });
});
