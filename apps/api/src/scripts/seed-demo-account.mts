// Loads .env.local so this script runs straight from a fresh clone.
import '@retailos/config/auto';

/**
 * Creates or repairs the one shared local demo identity before the tenant seed runs.
 *
 * This deliberately uses UserRepository's real verification/reset flows and the production
 * Argon2id password hasher. It never inserts a plaintext password or bypasses email verification.
 * The organization itself remains seed-demo.mts's concern, so identity and corpus rebuilding stay
 * independently idempotent.
 */
import { createDb, hashPassword, UserRepository } from '@retailos/db';

const DEMO_EMAIL = 'demo@vyapaar.test';
const DEMO_PASSWORD = 'Vyapaar-Demo-Cafe-2026!';

const { db, client } = createDb(process.env.DATABASE_URL!);
const users = new UserRepository(db);
const passwordHash = await hashPassword(DEMO_PASSWORD);
const existing = await users.findByEmail(DEMO_EMAIL);

let action: 'created' | 'repaired';

if (!existing) {
  const created = await users.createWithVerificationToken(DEMO_EMAIL, passwordHash);
  const verified = await users.verifyEmail(created.token.raw);
  if (!verified.ok) throw new Error(`Could not verify the newly-created demo account: ${verified.reason}.`);
  action = 'created';
} else {
  if (!existing.passwordHash) {
    throw new Error(
      `${DEMO_EMAIL} exists as an OAuth-only account. Remove that local-only user before rebuilding the demo.`
    );
  }

  const resetToken = await users.requestPasswordReset(DEMO_EMAIL);
  if (!resetToken) throw new Error('Could not issue a password-reset token for the demo account.');
  const reset = await users.resetPassword(resetToken.raw, passwordHash);
  if (!reset.ok) throw new Error(`Could not reset the demo account password: ${reset.reason}.`);

  if (!existing.emailVerifiedAt) {
    const verificationToken = await users.issueVerificationTokenFor(existing.id);
    const verified = await users.verifyEmail(verificationToken.raw);
    if (!verified.ok) throw new Error(`Could not verify the existing demo account: ${verified.reason}.`);
  }
  action = 'repaired';
}

console.log(JSON.stringify({ stage: 'demo-account', action, email: DEMO_EMAIL }, null, 2));
await client.end();
process.exit(0);
