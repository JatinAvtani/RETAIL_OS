import { describe, expect, it } from 'vitest';
import { createMockNotificationEmailSender, type SendNotificationEmailInput } from './notification-email-sender.js';

describe('createMockNotificationEmailSender', () => {
  it('never makes a real network call and succeeds with a real message id by default', async () => {
    const sender = createMockNotificationEmailSender();
    const result = await sender.send({ to: 'owner@example.com', subject: '[HIGH] Stock below reorder point', bodyText: 'Body' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messageId).toMatch(/^mock-/);
    }
  });

  it('invokes onSend with the exact input on success', async () => {
    let captured: SendNotificationEmailInput | null = null;
    const sender = createMockNotificationEmailSender({ onSend: (input) => { captured = input; } });
    await sender.send({ to: 'owner@example.com', subject: 'Subject', bodyText: 'Body' });
    expect(captured).not.toBeNull();
    expect(captured!.to).toBe('owner@example.com');
  });

  it('simulates a transient failure when failFor matches, without calling onSend', async () => {
    let onSendCalled = false;
    const sender = createMockNotificationEmailSender({
      onSend: () => { onSendCalled = true; },
      failFor: (input) => input.to === 'flaky@example.com',
    });
    const result = await sender.send({ to: 'flaky@example.com', subject: 'X', bodyText: 'Y' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
    expect(onSendCalled).toBe(false);
  });

  it('only fails the matching input, not every send from the same sender', async () => {
    const sender = createMockNotificationEmailSender({ failFor: (input) => input.to === 'flaky@example.com' });
    const failing = await sender.send({ to: 'flaky@example.com', subject: 'X', bodyText: 'Y' });
    const succeeding = await sender.send({ to: 'ok@example.com', subject: 'X', bodyText: 'Y' });
    expect(failing.ok).toBe(false);
    expect(succeeding.ok).toBe(true);
  });
});
