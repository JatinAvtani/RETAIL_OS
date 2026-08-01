import { TRPCError } from '@trpc/server';
import { RateLimiter, type createRedisClient } from '@retailos/session';

type Redis = ReturnType<typeof createRedisClient>;

/**
 * Spec 14 §14.2: "Rate limiting on auth endpoints: per IP, per account, with progressive delay and
 * lockout." Two independent scopes, checked together in `enforceAuthRateLimit` — an attacker
 * spraying different emails from one IP is caught by the IP limiter even though no single account
 * ever crosses its own threshold; a distributed attack against one account from many IPs is caught
 * by the account limiter even though no single IP does.
 *
 * Numbers: 5 failed attempts per account / 15 minutes, 20 failed attempts per IP / 15 minutes
 * (wider, since one IP legitimately serves many real users — e.g. an office or a café's own
 * network), both locking for 15 minutes. Not spec-mandated figures; a defensible, standard-shaped
 * default for a portfolio project with no real attacker traffic to tune against.
 */
const ACCOUNT_LIMIT_OPTIONS = { maxAttempts: 5, windowSeconds: 15 * 60, lockoutSeconds: 15 * 60 };
const IP_LIMIT_OPTIONS = { maxAttempts: 20, windowSeconds: 15 * 60, lockoutSeconds: 15 * 60 };
/**
 * Its own scope, not `auth-ip`: a password-reset request is a much lower-frequency legitimate
 * action than signup, so it gets its own, tighter budget rather than sharing signup's counter
 * (which would let a burst of real signups from one IP eat into an unrelated reset budget, or
 * vice versa).
 */
const RESET_REQUEST_IP_LIMIT_OPTIONS = { maxAttempts: 10, windowSeconds: 15 * 60, lockoutSeconds: 15 * 60 };

export type AuthRateLimiters = {
  perAccount: RateLimiter;
  perIp: RateLimiter;
  passwordResetRequestPerIp: RateLimiter;
};

export const createAuthRateLimiters = (redis: Redis): AuthRateLimiters => ({
  perAccount: new RateLimiter(redis, 'auth-account', ACCOUNT_LIMIT_OPTIONS),
  perIp: new RateLimiter(redis, 'auth-ip', IP_LIMIT_OPTIONS),
  passwordResetRequestPerIp: new RateLimiter(redis, 'password-reset-request-ip', RESET_REQUEST_IP_LIMIT_OPTIONS),
});

/** Emails are matched case-insensitively everywhere else in this codebase (citext); match that here. */
const accountKey = (email: string): string => email.toLowerCase();

/**
 * Throws `TOO_MANY_REQUESTS` if either the account or the IP is currently locked out. Callers
 * check this before doing any real work (password verification, DB lookups) — a locked-out
 * request should be cheap to reject, not pay the cost of the operation it's blocking.
 */
export const enforceAuthRateLimit = async (
  limiters: AuthRateLimiters,
  email: string,
  ip: string
): Promise<void> => {
  const [accountCheck, ipCheck] = await Promise.all([
    limiters.perAccount.check(accountKey(email)),
    limiters.perIp.check(ip),
  ]);

  const blocked = !accountCheck.allowed ? accountCheck : !ipCheck.allowed ? ipCheck : null;
  if (blocked) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many attempts. Please try again later.',
    });
  }
};

/** Records a failure against both scopes — called after a genuine auth failure, never speculatively. */
export const recordAuthFailure = async (
  limiters: AuthRateLimiters,
  email: string,
  ip: string
): Promise<void> => {
  await Promise.all([
    limiters.perAccount.recordFailure(accountKey(email)),
    limiters.perIp.recordFailure(ip),
  ]);
};

/** Clears both scopes — called after a genuine success so real users are never penalized later. */
export const resetAuthRateLimit = async (
  limiters: AuthRateLimiters,
  email: string,
  ip: string
): Promise<void> => {
  await Promise.all([limiters.perAccount.reset(accountKey(email)), limiters.perIp.reset(ip)]);
};

/**
 * IP-only variants for signup: there's no existing account to guess against pre-creation, so the
 * abuse this bounds is mass account creation from one IP, not per-account brute force.
 */
export const enforceSignupRateLimit = async (limiters: AuthRateLimiters, ip: string): Promise<void> => {
  const check = await limiters.perIp.check(ip);
  if (!check.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many attempts. Please try again later.',
    });
  }
};

export const recordSignupAttempt = async (limiters: AuthRateLimiters, ip: string): Promise<void> => {
  await limiters.perIp.recordFailure(ip);
};

/** IP-only, same shape as signup's: a reset request has no reliably-known account until the token exists. */
export const enforcePasswordResetRequestRateLimit = async (
  limiters: AuthRateLimiters,
  ip: string
): Promise<void> => {
  const check = await limiters.passwordResetRequestPerIp.check(ip);
  if (!check.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many attempts. Please try again later.',
    });
  }
};

export const recordPasswordResetRequestAttempt = async (
  limiters: AuthRateLimiters,
  ip: string
): Promise<void> => {
  await limiters.passwordResetRequestPerIp.recordFailure(ip);
};
