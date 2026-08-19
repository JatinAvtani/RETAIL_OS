/**
 * parsing + auth for Postmark's real Inbound Parse webhook payload
 * shape, researched directly from Postmark's own developer docs (developer.postmark.com/developer/
 * webhooks/inbound-webhook), not guessed — matching this project's established discipline of
 * researching real vendor shapes before building (Square's Orders/Catalog APIs, Google's OAuth
 * flow). No real Postmark account exists for this project (no domain to point MX records at, and
 * the no-card/no-cost constraint doesn't block Postmark specifically, but there's no domain to
 * verify) — confirmed with the user: this module is built as real, fully tested code against
 * Postmark's documented real shape, exercised in tests via realistic payloads rather than a live
 * email, the same precedent already established for `packages/pos`'s Square code (no live sandbox
 * app exists there either).
 */

export interface PostmarkAttachment {
  Name: string;
  Content: string; // base64-encoded raw bytes
  ContentType: string;
  ContentLength: number;
}

export interface PostmarkInboundPayload {
  FromFull: { Email: string; Name: string; MailboxHash: string };
  ToFull: { Email: string; Name: string; MailboxHash: string }[];
  Subject: string;
  Attachments: PostmarkAttachment[];
}

export class PostmarkParseError extends Error {}

/**
 * `FromFull.Email` is used for sender identity — NEVER the plain `From` string, which Postmark's
 * own docs don't confirm is reliably a bare address (it could theoretically be `"Name" <email>`,
 * matching the format their docs DO confirm for `To`/`Cc`/`Bcc`). `FromFull.Email` is documented as
 * always just the address, with no parsing required or risked.
 */
export const parsePostmarkInboundPayload = (rawBody: string): PostmarkInboundPayload => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (e) {
    throw new PostmarkParseError(`Malformed JSON: ${(e as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new PostmarkParseError('Payload is not a JSON object.');
  }
  const p = parsed as Record<string, unknown>;

  const fromFull = p.FromFull as { Email?: unknown; Name?: unknown; MailboxHash?: unknown } | undefined;
  if (!fromFull || typeof fromFull.Email !== 'string' || fromFull.Email.length === 0) {
    throw new PostmarkParseError('Missing or invalid FromFull.Email.');
  }

  const toFull = p.ToFull;
  if (!Array.isArray(toFull) || toFull.length === 0) {
    throw new PostmarkParseError('Missing or empty ToFull.');
  }
  for (const recipient of toFull) {
    if (typeof recipient?.Email !== 'string' || recipient.Email.length === 0) {
      throw new PostmarkParseError('A ToFull entry is missing a valid Email.');
    }
  }

  const attachments = p.Attachments;
  if (attachments !== undefined && !Array.isArray(attachments)) {
    throw new PostmarkParseError('Attachments, when present, must be an array.');
  }
  const validatedAttachments: PostmarkAttachment[] = (attachments ?? []).map((a: unknown, i: number) => {
    const att = a as Record<string, unknown>;
    if (typeof att.Name !== 'string' || typeof att.Content !== 'string' || typeof att.ContentType !== 'string' || typeof att.ContentLength !== 'number') {
      throw new PostmarkParseError(`Attachments[${i}] is missing a required field.`);
    }
    return { Name: att.Name, Content: att.Content, ContentType: att.ContentType, ContentLength: att.ContentLength };
  });

  return {
    FromFull: { Email: fromFull.Email, Name: typeof fromFull.Name === 'string' ? fromFull.Name : '', MailboxHash: typeof fromFull.MailboxHash === 'string' ? fromFull.MailboxHash : '' },
    ToFull: toFull.map((r: { Email: string; Name?: unknown; MailboxHash?: unknown }) => ({
      Email: r.Email,
      Name: typeof r.Name === 'string' ? r.Name : '',
      MailboxHash: typeof r.MailboxHash === 'string' ? r.MailboxHash : '',
    })),
    Subject: typeof p.Subject === 'string' ? p.Subject : '',
    Attachments: validatedAttachments,
  };
};

/**
 * Postmark has no HMAC/signature scheme at all (confirmed directly from their webhooks-overview
 * doc: "Postmark does not currently support HMAC webhook signature verification") — their
 * documented mechanism is HTTP Basic Auth embedded in the configured webhook URL
 * (`https://user:pass@host/webhook`), which Postmark then sends back as a real `Authorization:
 * Basic...` header on every delivery. This is genuinely their real, complete auth story, not a
 * simplification — there is no stronger mechanism to implement instead.
 */
export const verifyPostmarkBasicAuth = (authorizationHeader: string | undefined, expectedUsername: string, expectedPassword: string): boolean => {
  if (!authorizationHeader?.startsWith('Basic ')) {
    return false;
  }
  const decoded = Buffer.from(authorizationHeader.slice('Basic '.length), 'base64').toString('utf8');
  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    return false;
  }
  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  return username === expectedUsername && password === expectedPassword;
};

/**
 * Extracts the tenant slug from a recipient address shaped `invoices@<slug>.retailos.app` (the design's
 * "per-tenant address"). Returns null for any address that doesn't match this exact shape — a
 * malformed or unexpected recipient is "organization not resolved," never a guessed slug.
 */
export const extractOrganizationSlugFromRecipient = (recipientEmail: string): string | null => {
  const match = /^invoices@([a-z0-9-]+)\.retailos\.app$/i.exec(recipientEmail.trim());
  const slug = match?.[1];
  return slug ? slug.toLowerCase() : null;
};
