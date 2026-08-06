import { describe, expect, it } from 'vitest';
import { extractOrganizationSlugFromRecipient, parsePostmarkInboundPayload, PostmarkParseError, verifyPostmarkBasicAuth } from './postmark-inbound';

const realPostmarkPayload = {
  FromName: 'Nova Foods',
  MessageStream: 'inbound',
  From: 'billing@novafoods.example',
  FromFull: { Email: 'billing@novafoods.example', Name: 'Nova Foods', MailboxHash: '' },
  To: '"Ardent Bakehouse" <invoices+hash@ardent-bakehouse.retailos.app>',
  ToFull: [{ Email: 'invoices@ardent-bakehouse.retailos.app', Name: 'Ardent Bakehouse', MailboxHash: '' }],
  Subject: 'Invoice #8891',
  MessageID: '73e6d360-66eb-11e1-8e72-a8904824019b',
  Date: 'Fri, 1 Aug 2014 16:45:32 -04:00',
  TextBody: 'Please find attached invoice.',
  HtmlBody: '<p>Please find attached invoice.</p>',
  Attachments: [
    { Name: 'invoice-8891.pdf', Content: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'), ContentType: 'application/pdf', ContentLength: 15 },
  ],
};

describe('parsePostmarkInboundPayload', () => {
  it('parses a real-shaped Postmark inbound payload', () => {
    const result = parsePostmarkInboundPayload(JSON.stringify(realPostmarkPayload));
    expect(result.FromFull.Email).toBe('billing@novafoods.example');
    expect(result.ToFull[0]?.Email).toBe('invoices@ardent-bakehouse.retailos.app');
    expect(result.Subject).toBe('Invoice #8891');
    expect(result.Attachments).toHaveLength(1);
    expect(result.Attachments[0]?.Name).toBe('invoice-8891.pdf');
    expect(result.Attachments[0]?.ContentType).toBe('application/pdf');
  });

  it('parses a payload with zero attachments', () => {
    const { Attachments, ...withoutAttachments } = realPostmarkPayload;
    const result = parsePostmarkInboundPayload(JSON.stringify(withoutAttachments));
    expect(result.Attachments).toEqual([]);
  });

  it('throws PostmarkParseError on malformed JSON, never a generic error', () => {
    expect(() => parsePostmarkInboundPayload('not json{')).toThrow(PostmarkParseError);
  });

  it('throws PostmarkParseError when FromFull.Email is missing', () => {
    const { FromFull, ...rest } = realPostmarkPayload;
    expect(() => parsePostmarkInboundPayload(JSON.stringify(rest))).toThrow(PostmarkParseError);
  });

  it('throws PostmarkParseError when ToFull is empty', () => {
    const payload = { ...realPostmarkPayload, ToFull: [] };
    expect(() => parsePostmarkInboundPayload(JSON.stringify(payload))).toThrow(PostmarkParseError);
  });

  it('throws PostmarkParseError when an attachment is missing a required field', () => {
    const payload = { ...realPostmarkPayload, Attachments: [{ Name: 'x.pdf' }] };
    expect(() => parsePostmarkInboundPayload(JSON.stringify(payload))).toThrow(PostmarkParseError);
  });
});

describe('verifyPostmarkBasicAuth', () => {
  const auth = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

  it('accepts the correct username/password', () => {
    expect(verifyPostmarkBasicAuth(auth('webhook-user', 'secret-pass'), 'webhook-user', 'secret-pass')).toBe(true);
  });

  it('rejects a wrong password', () => {
    expect(verifyPostmarkBasicAuth(auth('webhook-user', 'wrong'), 'webhook-user', 'secret-pass')).toBe(false);
  });

  it('rejects a wrong username', () => {
    expect(verifyPostmarkBasicAuth(auth('attacker', 'secret-pass'), 'webhook-user', 'secret-pass')).toBe(false);
  });

  it('rejects a missing Authorization header', () => {
    expect(verifyPostmarkBasicAuth(undefined, 'webhook-user', 'secret-pass')).toBe(false);
  });

  it('rejects a non-Basic Authorization scheme', () => {
    expect(verifyPostmarkBasicAuth('Bearer sometoken', 'webhook-user', 'secret-pass')).toBe(false);
  });

  it('rejects a Basic header with no colon separator', () => {
    expect(verifyPostmarkBasicAuth(`Basic ${Buffer.from('nopasswordhere').toString('base64')}`, 'webhook-user', 'secret-pass')).toBe(false);
  });
});

describe('extractOrganizationSlugFromRecipient', () => {
  it('extracts the slug from a real-shaped recipient address', () => {
    expect(extractOrganizationSlugFromRecipient('invoices@ardent-bakehouse.retailos.app')).toBe('ardent-bakehouse');
  });

  it('is case-insensitive on the slug', () => {
    expect(extractOrganizationSlugFromRecipient('invoices@Ardent-Bakehouse.retailos.app')).toBe('ardent-bakehouse');
  });

  it('returns null for a recipient not shaped like the invoices address', () => {
    expect(extractOrganizationSlugFromRecipient('someone@gmail.com')).toBeNull();
  });

  it('returns null for a recipient missing the invoices@ local part', () => {
    expect(extractOrganizationSlugFromRecipient('billing@ardent-bakehouse.retailos.app')).toBeNull();
  });

  it('returns null for a completely different domain', () => {
    expect(extractOrganizationSlugFromRecipient('invoices@ardent-bakehouse.example.com')).toBeNull();
  });
});
