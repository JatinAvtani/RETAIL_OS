import { describe, expect, it } from 'vitest';
import { createMockPoEmailSender, type SendPurchaseOrderEmailInput } from './po-email-sender.js';

describe('createMockPoEmailSender', () => {
  it('never makes a real network call and always succeeds with a real message id', async () => {
    const sender = createMockPoEmailSender();
    const result = await sender.send({
      to: 'supplier@example.com',
      subject: 'Purchase Order PO-1001',
      bodyText: 'Please find attached.',
      attachment: { filename: 'PO-1001.pdf', contentType: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messageId).toMatch(/^mock-/);
    }
  });

  it('invokes the onSend hook with the exact input, so a caller can persist a real record of what was sent', async () => {
    let captured: SendPurchaseOrderEmailInput | null = null;
    const sender = createMockPoEmailSender((input) => {
      captured = input;
    });
    await sender.send({
      to: 'supplier@example.com',
      subject: 'Purchase Order PO-1002',
      bodyText: 'Body',
      attachment: { filename: 'PO-1002.pdf', contentType: 'application/pdf', bytes: new Uint8Array([9]) },
    });
    expect(captured).not.toBeNull();
    expect(captured!.to).toBe('supplier@example.com');
    expect(captured!.subject).toBe('Purchase Order PO-1002');
  });

  it('produces a different message id on each call', async () => {
    const sender = createMockPoEmailSender();
    const input: SendPurchaseOrderEmailInput = {
      to: 'a@example.com',
      subject: 'x',
      bodyText: 'x',
      attachment: { filename: 'x.pdf', contentType: 'application/pdf', bytes: new Uint8Array() },
    };
    const first = await sender.send(input);
    const second = await sender.send(input);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.messageId).not.toBe(second.messageId);
    }
  });
});
