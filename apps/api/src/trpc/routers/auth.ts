import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { checkPasswordPolicy, hashPassword, UserRepository, verifyPassword } from '@retailos/db';
import {
  establishSessionForUser,
  SESSION_COOKIE_NAME,
  setSessionCookie,
} from '../../auth/establish-session';
import {
  enforceAuthRateLimit,
  enforceSignupRateLimit,
  recordAuthFailure,
  recordSignupAttempt,
  resetAuthRateLimit,
} from '../../auth/rate-limit';
import { publicProcedure, router } from '../trpc';

const signupInput = z.object({
  email: z.string().email(),
  password: z.string(),
});

const verifyEmailInput = z.object({
  token: z.string(),
});

const loginInput = z.object({
  email: z.string().email(),
  password: z.string(),
});

/**
 * A real Argon2id hash of an arbitrary, never-used password — verified against when the email
 * doesn't match any user, so a nonexistent-email login takes roughly the same time as a
 * wrong-password one. Without this, the two cases have a measurably different response time (a
 * real Argon2id verify vs. an immediate return), which is exactly the account-enumeration timing
 * side-channel spec 14 §14.2 calls out ("timing-equalized responses").
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$bBI2ZkESMxXpGxfUtN7N1Q$vemx3i7Rv+2XEKGnPq7fIhqoVgEhmjs6Jc98p1tg6Kk';

/**
 * Enumeration-safe by design (spec 14 §14.2's "generic errors, no enumeration" intent, applied to
 * signup too, not just login — the spec only names login's case explicitly, confirmed with the
 * user that signup should follow the same posture): the response is identical whether or not the
 * email was already registered. What SHOULD differ is which email gets sent — a real "here's your
 * verification link" to a genuinely new signup, versus a "someone tried to sign up with your
 * email — log in instead" notice to the actual owner of an existing account. Neither email is
 * actually sent yet: there is no email-sending infrastructure anywhere in this project yet. This
 * is a real, tracked gap, not a silent omission — the verification token IS created and returned
 * to the caller only in non-duplicate cases for now, purely so the signup path is exercisable
 * end-to-end before email delivery exists; a real deployment must never return the token this way.
 */
export const authRouter = router({
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
    const { token } = await userRepository.createWithVerificationToken(input.email, passwordHash);

    return {
      message: 'Check your email to verify your account.',
      // TEMPORARY, until email sending exists: the real verification token, returned directly to
      // the caller instead of emailed. Must be removed the moment there is somewhere to send it.
      _devOnlyVerificationToken: token.raw,
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
   * Generic "invalid credentials" for every failure case (nonexistent email, wrong password,
   * unverified email, zero/multiple accepted memberships) — spec 14 §14.2 requires this
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
});
