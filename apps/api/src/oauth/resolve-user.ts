import { UserRepository } from '@retailos/db';
import type { GoogleIdentity } from './google';

type Db = ConstructorParameters<typeof UserRepository>[0];

export type ResolveGoogleUserResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'unverified_password_account_exists' };

/**
 * Given an already-verified Google identity (the caller has already exchanged the code and
 * confirmed the ID token), resolves it to a real user row: an existing Google-linked account, an
 * existing verified password account (linked in place), or a brand-new pre-verified account.
 * Split out from the route handler itself so this — the actual account-linking/creation decision,
 * including the account-takeover guard — is testable without a live Google OAuth exchange, which
 * an automated test can't perform.
 */
export const resolveGoogleUser = async (
  db: Db,
  identity: GoogleIdentity
): Promise<ResolveGoogleUserResult> => {
  const userRepository = new UserRepository(db);

  const existingByGoogleId = await userRepository.findByGoogleId(identity.googleId);
  if (existingByGoogleId) {
    return { ok: true, userId: existingByGoogleId.id };
  }

  const existingByEmail = await userRepository.findByEmail(identity.email);

  if (existingByEmail) {
    // Account-takeover guard: an unverified existing account cannot be silently
    // claimed by whoever next signs in with Google using the same email address — that would let
    // an attacker who merely knows a victim's email (not their password) take over the account by
    // racing to complete Google sign-in first. The real owner must prove password control before
    // the identities link.
    if (!existingByEmail.emailVerifiedAt) {
      return { ok: false, reason: 'unverified_password_account_exists' };
    }
    await userRepository.linkGoogleId(existingByEmail.id, identity.googleId);
    return { ok: true, userId: existingByEmail.id };
  }

  // Google already verified this email as part of its own sign-in flow — no separate verification
  // step needed, unlike a brand-new password signup.
  const userId = await userRepository.createFromGoogle(identity.email, identity.googleId, identity.name);
  return { ok: true, userId };
};
