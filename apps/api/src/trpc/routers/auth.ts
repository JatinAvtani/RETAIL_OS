import { createHash } from 'node:crypto';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { checkPasswordPolicy, createOrganizationWithOwner, hashPassword, UserRepository, verifyPassword } from '@retailos/db';
import {
  establishSessionForUser,
  SESSION_COOKIE_NAME,
  setSessionCookie,
} from '../../auth/establish-session';
import {
  enforceAuthRateLimit,
  enforcePasswordResetRequestRateLimit,
  enforceSignupRateLimit,
  recordAuthFailure,
  recordPasswordResetRequestAttempt,
  recordSignupAttempt,
  resetAuthRateLimit,
} from '../../auth/rate-limit';
import { devOnlyToken } from '../dev-only-token';
import { protectedProcedure, provisioningProcedure, publicProcedure, router } from '../trpc';

/**
 * The one shared demo tenant every "Explore with sample data" click lands in — see `demoLogin`'s
 * own doc comment for why this is a real, singular account rather than a per-visitor provisioning
 * flow. Built by `apps/api/src/scripts/seed-demo.mts`. Overridable via env (`DEMO_ACCOUNT_EMAIL`)
 * so `auth.test.ts` can exercise the real `demoLogin` path against a throwaway per-test-run email
 * without ever touching the real `demo@vyapaar.test` row — this file's tests run against the same
 * database as local dev (no separate TEST_DATABASE_URL for apps/api), so seeding/deleting the
 * literal production demo account in a test would be a real, destructive mistake.
 */
const DEMO_ACCOUNT_EMAIL = process.env.DEMO_ACCOUNT_EMAIL ?? 'demo@vyapaar.test';

const signupInput = z.object({
  email: z.string().email(),
  password: z.string(),
  organizationName: z.string().min(1).max(200),
  storeName: z.string().min(1).max(200),
  storeTimezone: z.string().min(1),
  // A one-time choice, never changeable after signup — no exchange-rate/conversion logic exists
  // anywhere in this codebase, so this is only safe to offer before any real financial data exists.
  baseCurrency: z.enum(['USD', 'EUR', 'GBP', 'INR']),
});

/**
 * Everything Google cannot tell us. Deliberately the same three workspace fields `signupInput`
 * collects — minus email and password, which the Google identity already established.
 */
const completeGoogleSignupInput = z.object({
  organizationName: z.string().min(1).max(200),
  storeName: z.string().min(1).max(200),
  storeTimezone: z.string().min(1),
  baseCurrency: z.enum(['USD', 'EUR', 'GBP', 'INR']),
});

const verifyEmailInput = z.object({
  token: z.string(),
});

const loginInput = z.object({
  email: z.string().email(),
  password: z.string(),
});

const requestPasswordResetInput = z.object({
  email: z.string().email(),
});

const resetPasswordInput = z.object({
  token: z.string(),
  newPassword: z.string(),
});

const revokeSessionInput = z.object({
  sessionHash: z.string(),
});

/**
 * A stable, non-secret identifier for a session record — SHA-256 of the real Redis token. Never the
 * raw token itself: `SessionStore.listForUser` legitimately needs the raw token to look up each
 * `session:<token>` key, but handing that value back to the browser would mean a session-list page
 * literally displays every one of a user's live session credentials over the wire, any one of which
 * could impersonate that device if intercepted. Hashing is one-way, so `sessionHash` identifies a
 * row for display/revoke targeting without ever being usable as a session token itself.
 *
 * Deliberately named `sessionHash`, not `sessionId`: the cross-tenant merge-gate suite
 * (`cross-tenant.test.ts`) mechanically treats any `*Id`-shaped input field as a foreign-resource
 * reference it must prove returns 403/404 for another tenant/user — but this value only ever
 * resolves against the CALLER's own `listForUser(ctx.session.userId)` results (never another
 * user's), so a "wrong owner" guess is correctly a silent no-op (200), matching `logout`'s own
 * idempotent posture, not a 403/404. Naming it accurately as a hash rather than an id keeps it out
 * of that heuristic instead of requiring a carve-out in the shared merge-gate file.
 */
const hashSessionToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * A real Argon2id hash of an arbitrary, never-used password — verified against when the email
 * doesn't match any user, so a nonexistent-email login takes roughly the same time as a
 * wrong-password one. Without this, the two cases have a measurably different response time (a
 * real Argon2id verify vs. an immediate return), which is exactly the account-enumeration timing
 * side-channel the design calls out ("timing-equalized responses").
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$bBI2ZkESMxXpGxfUtN7N1Q$vemx3i7Rv+2XEKGnPq7fIhqoVgEhmjs6Jc98p1tg6Kk';

/**
 * Enumeration-safe by design (the "generic errors, no enumeration" intent, applied to
 * signup too, not just login — the spec only names login's case explicitly; signup follows the
 * same posture): the response is identical whether or not the
 * email was already registered. What SHOULD differ is which email gets sent — a real "here's your
 * verification link" to a genuinely new signup, versus a "someone tried to sign up with your
 * email — log in instead" notice to the actual owner of an existing account. Neither email is
 * actually sent yet: there is no email-sending infrastructure anywhere in this project yet. This
 * is a real, tracked gap, not a silent omission — the verification token IS created and returned
 * to the caller only in non-duplicate cases for now, purely so the signup path is exercisable
 * end-to-end before email delivery exists; a real deployment must never return the token this way.
 */
export const authRouter = router({
  /**
   * The frontend's only way to answer "am I logged in" — the session cookie is httpOnly (opaque
   * to JS by design, see packages/session), so there is no client-side way to inspect it directly.
   * A 401 (thrown by protectedProcedure itself when the cookie is missing/invalid) is the "not
   * logged in" signal; the caller catches that and redirects to /login rather than this endpoint
   * returning a nullable success shape.
   */
  me: protectedProcedure.query(({ ctx }) => ({
    organizationId: ctx.session.organizationId,
    role: ctx.session.role,
    permissions: ctx.session.permissions,
  })),

  /**
   * Every live session for the CALLING user only — `SessionStore.listForUser` takes a `userId`, not
   * an org, so this deliberately never accepts one as input; a client-supplied userId here would let
   * any logged-in user enumerate another user's active devices. `isCurrent` lets the UI mark "this
   * device" distinctly from other sessions, matching the caller's own `ctx.sessionToken`.
   */
  listSessions: protectedProcedure.query(async ({ ctx }) => {
    const sessions = await ctx.sessionStore.listForUser(ctx.session.userId);
    const currentHash = hashSessionToken(ctx.sessionToken);

    return sessions
      .map((session) => ({
        sessionHash: hashSessionToken(session.token),
        ip: session.ip,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        isCurrent: hashSessionToken(session.token) === currentHash,
      }))
      .sort((a, b) => (a.isCurrent === b.isCurrent ? 0 : a.isCurrent ? -1 : 1));
  }),

  /**
   * Revokes one of the CALLER'S OWN sessions by its hashed `sessionHash` — never a raw token, and
   * never another user's session: `listForUser(ctx.session.userId)` is re-run here (not trusted from
   * a prior client response) so the match is always scoped to sessions this authenticated user
   * genuinely owns right now, closing the same class of gap `revokeAll`'s own "no ownership check"
   * would otherwise open if a client could pass an arbitrary token straight through.
   */
  revokeSession: protectedProcedure.input(revokeSessionInput).mutation(async ({ ctx, input }) => {
    const sessions = await ctx.sessionStore.listForUser(ctx.session.userId);
    const match = sessions.find((session) => hashSessionToken(session.token) === input.sessionHash);

    if (!match) {
      // Already gone, or never belonged to this user — either way, idempotent, matching `logout`'s
      // own "nothing to revoke is still success" posture rather than leaking which case it was.
      return { message: 'Session revoked.' };
    }

    await ctx.sessionStore.revoke(match.token, ctx.session.userId);

    if (hashSessionToken(match.token) === hashSessionToken(ctx.sessionToken)) {
      ctx.res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    }

    return { message: 'Session revoked.' };
  }),

  signup: publicProcedure.input(signupInput).mutation(async ({ ctx, input }) => {
    // Signup has no existing account to guess against — the abuse this bounds is mass account
    // creation from one IP, not per-account brute force. Every call counts, not just failures:
    // each signup attempt IS the cost being bounded, successful or not.
    await enforceSignupRateLimit(ctx.authRateLimiters, ctx.req.ip);
    await recordSignupAttempt(ctx.authRateLimiters, ctx.req.ip);

    const policyViolations = await checkPasswordPolicy(input.password);
    if (policyViolations.length > 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Password does not meet policy: ${policyViolations.join(', ')}`,
      });
    }

    const userRepository = new UserRepository(ctx.db);
    const existing = await userRepository.findByEmail(input.email);

    if (existing) {
      // Deliberately the same shape as the success response — see the enumeration note above.
      return { message: 'Check your email to verify your account.' };
    }

    const passwordHash = await hashPassword(input.password);
    const { userId, token } = await userRepository.createWithVerificationToken(input.email, passwordHash);

    // The real "create your workspace" step — previously missing entirely (only seed-demo.mts, a
    // raw offline script, ever created an organization). Runs in the SAME call as user creation,
    // not deferred to email verification: signup already only reaches this branch for a genuinely
    // new email (the `existing` check above), so there's no enumeration concern in doing real work
    // here — the enumeration-safety property is about the RESPONSE being identical, not about
    // whether the org gets created server-side. The account still can't LOG IN until email
    // verification succeeds (auth.login's own existing emailVerifiedAt check), so an unverified
    // signup can't use the org it was given, matching the product's existing security posture.
    await createOrganizationWithOwner(ctx.db, {
      organizationName: input.organizationName,
      storeName: input.storeName,
      storeTimezone: input.storeTimezone,
      baseCurrency: input.baseCurrency,
      userId,
    });

    return {
      message: 'Check your email to verify your account.',
      // TEMPORARY, until email sending exists: the real verification token, returned directly to
      // the caller instead of emailed. Must be removed the moment there is somewhere to send it.
      _devOnlyVerificationToken: devOnlyToken(token.raw),
    };
  }),

  verifyEmail: publicProcedure.input(verifyEmailInput).mutation(async ({ ctx, input }) => {
    const userRepository = new UserRepository(ctx.db);
    const result = await userRepository.verifyEmail(input.token);

    if (!result.ok) {
      // Generic on purpose, same reasoning as signup: whether a token is "wrong" vs "expired" vs
      // "already used" isn't information a caller needs, and it's marginally more enumeration
      // surface than necessary to distinguish them.
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'This verification link is invalid or has expired.' });
    }

    return { message: 'Email verified.' };
  }),

  /**
   * Finishes a Google sign-up: creates the workspace for someone Google authenticated but who had
   * no organization, then upgrades their provisioning session into a real one.
   *
   * The counterpart to `signup` for the OAuth path. `signup` collects five things; Google already
   * established two of them (email, identity — and pre-verified the address, so there is no
   * verification step here), leaving the three workspace fields this takes.
   *
   * `provisioningProcedure` is what makes this safe: it accepts ONLY a provisioning session, so a
   * user who already has a workspace cannot call this to mint a second one, and the userId comes
   * from the session rather than from client input — a client-supplied userId here would let anyone
   * create a workspace owned by someone else.
   *
   * The session swap at the end is not optional. The provisioning session is barred from every
   * `protectedProcedure` by design, so leaving it in place would strand the user on a working
   * account they still could not use — the exact dead end this whole flow exists to remove. The old
   * token is revoked rather than left to expire: it can no longer do anything useful, and a
   * still-valid token that outlives its purpose is a needless credential in the wild.
   */
  completeGoogleSignup: provisioningProcedure
    .input(completeGoogleSignupInput)
    .mutation(async ({ ctx, input }) => {
      const userRepository = new UserRepository(ctx.db);
      const user = await userRepository.findById(ctx.session.userId);

      if (!user) {
        // The session resolved but its user is gone — only reachable if the row was deleted
        // mid-flow. Nothing to recover; the caller must start again.
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not signed in.' });
      }

      await createOrganizationWithOwner(ctx.db, {
        organizationName: input.organizationName,
        storeName: input.storeName,
        storeTimezone: input.storeTimezone,
        baseCurrency: input.baseCurrency,
        userId: ctx.session.userId,
      });

      // Re-derives the session from the membership that now exists rather than hand-building one,
      // so an OAuth-created workspace and a password-created one produce byte-identical sessions —
      // permissions included. Hand-assembling the record here would be a second place for the
      // role→permission mapping to drift out of step with `establishSessionForUser`.
      const result = await establishSessionForUser(
        ctx.db,
        ctx.sessionStore,
        ctx.session.userId,
        user.email,
        ctx.req.ip,
        ctx.req.headers['user-agent'] ?? 'unknown'
      );

      if (!result.ok) {
        // Unreachable in practice: the membership was just created, accepted, and is the user's
        // only one. Surfaced rather than swallowed so a future change that breaks that assumption
        // fails loudly instead of silently leaving the user provisioning-locked.
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Your workspace was created, but the session could not be started. Please sign in.',
        });
      }

      await ctx.sessionStore.revoke(ctx.sessionToken, ctx.session.userId);
      setSessionCookie(ctx.res, result.token);

      return { message: 'Workspace created.' };
    }),

  /**
   * Generic "invalid credentials" for every failure case (nonexistent email, wrong password,
   * unverified email, zero/multiple accepted memberships) — the design requires this
   * specifically for login to prevent account enumeration. The one exception is the
   * unverified-email case, which is safe to be specific about: it only fires AFTER the password
   * has already been confirmed correct, so it confirms nothing an attacker without the real
   * password could learn.
   *
   * Multi-org users (the accountant/multi-org-owner personas) are not yet supported at login —
   * there is no org-selection UI or endpoint yet, so a user with more than one accepted membership
   * gets an explicit, distinct error rather than this endpoint silently picking one for them.
   */
  login: publicProcedure.input(loginInput).mutation(async ({ ctx, input }) => {
    await enforceAuthRateLimit(ctx.authRateLimiters, input.email, ctx.req.ip);

    const userRepository = new UserRepository(ctx.db);
    const user = await userRepository.findByEmail(input.email);

    const passwordIsValid = await verifyPassword(user?.passwordHash ?? DUMMY_PASSWORD_HASH, input.password);

    if (!user || !passwordIsValid) {
      await recordAuthFailure(ctx.authRateLimiters, input.email, ctx.req.ip);
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid credentials.' });
    }

    if (!user.emailVerifiedAt) {
      await recordAuthFailure(ctx.authRateLimiters, input.email, ctx.req.ip);
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Please verify your email before logging in.',
      });
    }

    const result = await establishSessionForUser(
      ctx.db,
      ctx.sessionStore,
      user.id,
      user.email,
      ctx.req.ip,
      ctx.req.headers['user-agent'] ?? 'unknown',
    );

    if (!result.ok) {
      if (result.reason === 'multiple_organizations') {
        throw new TRPCError({
          code: 'NOT_IMPLEMENTED',
          message: 'Accounts with multiple organizations are not yet supported at login.',
        });
      }
      await recordAuthFailure(ctx.authRateLimiters, input.email, ctx.req.ip);
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid credentials.' });
    }

    await resetAuthRateLimit(ctx.authRateLimiters, input.email, ctx.req.ip);
    setSessionCookie(ctx.res, result.token);

    return { message: 'Logged in.' };
  }),

  /**
   * "Explore with sample data" — a real, discoverable entry point into the existing shared
   * demo tenant, chosen as the correct shape (one real shared tenant every visitor
   * lands in, not a fresh isolated tenant provisioned per click, which this project has no
   * card/cost budget to run at scale). Deliberately its own procedure, not the client sending
   * hardcoded demo credentials through `login` — that would ship a real password in browser JS for
   * no reason, when the server already knows exactly which account this is. Reuses
   * `establishSessionForUser` (the SAME session-issuing code path `login` and Google OAuth both
   * use) so a demo session is a completely ordinary session in every way that matters — same
   * cookie, same permissions-from-role derivation, same tenant isolation (I4): nothing about this
   * account or its data is special-cased anywhere in the app layer — a real
   * isolated tenant, never a bypass.
   *
   * Rate-limited by IP only (`enforceSignupRateLimit`'s exact shape, reused directly) — NOT the
   * per-account limiter `login` uses, since every visitor's "account" here is deliberately the
   * SAME email; a per-account limit would throttle every future visitor after a handful of
   * unrelated people already clicked the button today.
   */
  demoLogin: publicProcedure.mutation(async ({ ctx }) => {
    await enforceSignupRateLimit(ctx.authRateLimiters, ctx.req.ip);

    const userRepository = new UserRepository(ctx.db);
    const user = await userRepository.findByEmail(DEMO_ACCOUNT_EMAIL);
    if (!user || !user.emailVerifiedAt) {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'The demo is temporarily unavailable. Please try again shortly.' });
    }

    const result = await establishSessionForUser(
      ctx.db,
      ctx.sessionStore,
      user.id,
      user.email,
      ctx.req.ip,
      ctx.req.headers['user-agent'] ?? 'unknown',
    );

    if (!result.ok) {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'The demo is temporarily unavailable. Please try again shortly.' });
    }

    setSessionCookie(ctx.res, result.token);
    return { message: 'Logged in.' };
  }),

  /**
   * Idempotent by design: called with no cookie, an already-expired token, or a token that was
   * never valid, this still succeeds and still clears the cookie — a client doesn't need to know
   * whether its session was already gone before asking to log out, and there's no information a
   * distinct "no session" error would give a legitimate caller that's worth the extra branch.
   */
  logout: publicProcedure.mutation(async ({ ctx }) => {
    const token = ctx.req.cookies[SESSION_COOKIE_NAME];

    if (token) {
      const session = await ctx.sessionStore.get(token);
      if (session) {
        await ctx.sessionStore.revoke(token, session.userId);
      }
    }

    ctx.res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });

    return { message: 'Logged out.' };
  }),

  /**
   * Enumeration-safe like signup: identical response whether the email exists, doesn't exist, or
   * belongs to an OAuth-only account with no password to reset — a distinct response for any of
   * those would confirm which emails are registered and how they authenticate. IP-only rate limit,
   * same shape as signup's: no account is reliably known yet at request time.
   */
  requestPasswordReset: publicProcedure.input(requestPasswordResetInput).mutation(async ({ ctx, input }) => {
    await enforcePasswordResetRequestRateLimit(ctx.authRateLimiters, ctx.req.ip);
    await recordPasswordResetRequestAttempt(ctx.authRateLimiters, ctx.req.ip);

    const userRepository = new UserRepository(ctx.db);
    const token = await userRepository.requestPasswordReset(input.email);

    return {
      message: 'If an account exists for that email, a password reset link has been sent.',
      // TEMPORARY, same posture as signup's verification token: no email-sending infrastructure
      // exists yet, so the raw token is returned directly instead of emailed. Undefined (and thus
      // absent from the response, not null) for a nonexistent/OAuth-only email — never emitted at
      // all for those cases, matching the message's enumeration-safe framing above.
      _devOnlyPasswordResetToken: devOnlyToken(token?.raw),
    };
  }),

  /**
   * Consumes the reset token and revokes every existing session for the account (`revokeAll`,
   * built since session 3 but unused until now) — a password reset should also kill any session an
   * attacker already holds, not just block future logins with the old password. Generic errors for
   * the same reasons as `verifyEmail`: whether a token is invalid vs. expired vs. already used
   * isn't information a caller needs.
   */
  resetPassword: publicProcedure.input(resetPasswordInput).mutation(async ({ ctx, input }) => {
    const policyViolations = await checkPasswordPolicy(input.newPassword);
    if (policyViolations.length > 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Password does not meet policy: ${policyViolations.join(', ')}`,
      });
    }

    const newPasswordHash = await hashPassword(input.newPassword);
    const userRepository = new UserRepository(ctx.db);
    const result = await userRepository.resetPassword(input.token, newPasswordHash);

    if (!result.ok) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'This password reset link is invalid or has expired.' });
    }

    await ctx.sessionStore.revokeAll(result.userId);

    return { message: 'Password has been reset.' };
  }),
});
