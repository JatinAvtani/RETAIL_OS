import { UserRepository } from '@retailos/db';
import type { GoogleIdentity } from './google';

type Db = ConstructorParameters<typeof UserRepository>[0];

export type ResolveGoogleUserResult =
  | {
      ok: true;
      userId: string;
      /**
       * True only when this call created the `users` row. Reported for callers that care about
       * first-contact specifically; it is deliberately NOT what decides whether someone is sent to
       * finish signup — see `needsWorkspace` below.
       */
      created: boolean;
      /**
       * True when this account has no password: it exists solely because someone signed in with
       * Google. Combined with "has no membership", it is what identifies a user whose only sensible
       * destination is workspace setup.
       *
       * `created` alone was the first version of this check and was wrong in a way tests did not
       * catch: it only ever fired on the very FIRST Google sign-in. Someone who signed in, reached
       * the setup page and closed the tab came back to an account that could never be entered by
       * any route — no password to sign in with, and a returning Google sign-in resolved to
       * `created: false` and fell through to the no-membership error. A passwordless account,
       * unlike an established one whose membership was revoked, has no other state it could
       * legitimately be in, so it is safe to route to setup on every visit, not just the first.
       */
      needsWorkspace: boolean;
    }
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
    // A returning Google user. Passwordless means their account exists only via Google, so if they
    // also have no workspace they belong in setup — the abandoned-setup case.
    return {
      ok: true,
      userId: existingByGoogleId.id,
      created: false,
      needsWorkspace: existingByGoogleId.passwordHash === null,
    };
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
    // Linked to an existing PASSWORD account, so they can always sign in the original way; a
    // missing membership here is a real error, not an unfinished signup.
    return { ok: true, userId: existingByEmail.id, created: false, needsWorkspace: false };
  }

  // Google already verified this email as part of its own sign-in flow — no separate verification
  // step needed, unlike a brand-new password signup.
  const userId = await userRepository.createFromGoogle(identity.email, identity.googleId, identity.name);
  return { ok: true, userId, created: true, needsWorkspace: true };
};
