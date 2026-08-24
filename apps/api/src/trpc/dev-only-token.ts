/**
 * Gates the `_devOnly*` token fields that stand in for email delivery.
 *
 * Three public mutations return a raw secret directly to the caller because no email-sending
 * infrastructure exists yet: signup's verification token, `requestPasswordReset`'s reset token, and
 * `invitations.create`'s invitation token. Each was already documented as temporary, but none was
 * gated by environment — so in a production deployment `requestPasswordReset` would hand the raw
 * password-reset token to anyone who could name an email address. That is account-takeover shaped,
 * and it is the first thing a security reviewer greps for.
 *
 * Returning `undefined` (rather than `null`) omits the key from the JSON response entirely, so a
 * production response carries no trace of the field — matching how `_devOnlyPasswordResetToken`
 * already handled its own nonexistent-email case.
 *
 * Suppression is keyed on `NODE_ENV === 'production'` specifically, rather than "anything that is
 * not development". A stricter fail-closed version (treating an UNSET `NODE_ENV` as production) was
 * written first and rejected against how this repo actually runs: `apps/api`'s dev script is a bare
 * `tsx watch src/start.ts` that sets no `NODE_ENV` at all, and three real web pages
 * (`signup`, `forgot-password`, `settings`) read these tokens to complete their flows. Failing
 * closed there would silently break local signup, password reset, and invitations — a developer
 * would see a broken app with no error explaining why, and the likely "fix" is deleting the gate.
 *
 * The deployment that matters is the one that sets `NODE_ENV=production`, which every Node hosting
 * platform and the `next build`/`next start` path do by default. Guarding that exact value is the
 * check that holds where it counts without breaking the environments this project actually runs in.
 *
 * Delete this helper and all three call sites the moment real email delivery exists.
 */
export const devOnlyToken = (raw: string | undefined): string | undefined =>
  process.env.NODE_ENV === 'production' ? undefined : raw;
