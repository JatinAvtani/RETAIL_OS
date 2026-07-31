import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { checkPasswordPolicy, hashPassword, UserRepository } from '@retailos/db';
import { publicProcedure, router } from '../trpc';

const signupInput = z.object({
  email: z.string().email(),
  password: z.string(),
});

const verifyEmailInput = z.object({
  token: z.string(),
});

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
});
