/**
 * 008-06: spec 05 §5.2.2, "SENT triggers PDF generation + email to the supplier contact." Confirmed
 * with the user: the transport is mocked, not a real provider — the same precedent as
 * `postmark-inbound.ts` (inbound email is really parsed; Postmark's own account/domain is not).
 * plan.md itself flags real deliverability (a dedicated transactional sending domain with
 * SPF/DKIM/DMARC) as a genuinely hard problem for a small supplier's spam filter — one this
 * project's no-card/no-cost constraint rules out solving for real. `PoEmailSender` is a real
 * interface (matching `ExtractionProvider`'s dual-provider precedent in packages/ai) so a real
 * provider can be swapped in later without touching any caller.
 */

export type PoEmailAttachment = {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
};

export type SendPurchaseOrderEmailInput = {
  to: string;
  subject: string;
  bodyText: string;
  attachment: PoEmailAttachment;
};

export type SendPurchaseOrderEmailResult = {
  ok: true;
  messageId: string;
} | {
  ok: false;
  error: string;
};

export interface PoEmailSender {
  send(input: SendPurchaseOrderEmailInput): Promise<SendPurchaseOrderEmailResult>;
}

/**
 * Never makes a real network call — records the send in-memory (via the provided `onSend` hook,
 * used by tests and by the caller to persist a real audit trail) and always succeeds, since there
 * is no real transport to fail. A missing `to` address (no confirmed supplier contact email) is the
 * CALLER's concern (I7 — "no contact on file" must degrade to a visible, honest state, not a mocked
 * success), not something this sender silently papers over.
 */
export const createMockPoEmailSender = (onSend?: (input: SendPurchaseOrderEmailInput) => void): PoEmailSender => ({
  async send(input) {
    onSend?.(input);
    return { ok: true, messageId: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
  },
});
