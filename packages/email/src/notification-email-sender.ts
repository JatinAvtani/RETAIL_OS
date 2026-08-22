/**
 * The transport for transactional alert email (spec 05 §5.7: "Transactional
 * sending domain separate from any marketing domain — reputation damage on one must not affect
 * the other, and an alert in spam is a missed stockout"). Deliberately a SEPARATE interface from
 * `PoEmailSender`, not a reuse — a purchase-order email is a supplier-facing document with a
 * required PDF attachment and exactly one recipient; a notification email is an internal alert
 * with no attachment, sent per-user. Mirroring `PoEmailSender`'s established shape (a real
 * interface so a real provider can be swapped in later, matching `ExtractionProvider`'s
 * dual-provider precedent) rather than forcing both concerns through one shared shape.
 */

export type SendNotificationEmailInput = {
  to: string;
  subject: string;
  bodyText: string;
};

export type SendNotificationEmailResult = {
  ok: true;
  messageId: string;
} | {
  ok: false;
  error: string;
};

export interface NotificationEmailSender {
  send(input: SendNotificationEmailInput): Promise<SendNotificationEmailResult>;
}

/**
 * Never makes a real network call — same no-card/no-cost constraint as `createMockPoEmailSender`.
 * Unlike the PO sender (which always succeeds, since it has no retry/DLQ concern of its own),
 * this one can be told to simulate a transient failure via `failFor`, a caller-supplied predicate
 * — the real work of the delivery pipeline (retry with backoff, then DEAD_LETTERED after exhausting attempts)
 * has nothing to prove itself against without a sender that can actually fail on command.
 */
export const createMockNotificationEmailSender = (options?: {
  onSend?: (input: SendNotificationEmailInput) => void;
  failFor?: (input: SendNotificationEmailInput) => boolean;
}): NotificationEmailSender => ({
  async send(input) {
    if (options?.failFor?.(input)) {
      return { ok: false, error: 'Simulated transient delivery failure' };
    }
    options?.onSend?.(input);
    return { ok: true, messageId: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
  },
});
