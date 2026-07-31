import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  acceptInvitationByTokenHash,
  findInvitationByTokenHash,
  InvitationRepository,
  UserRepository,
} from '@retailos/db';
import { protectedProcedure, router } from '../trpc';

const createInput = z.object({
  email: z.string().email(),
  role: z.enum(['OWNER', 'MANAGER', 'STAFF', 'VIEWER_FINANCE']),
  storeIds: z.array(z.string().uuid()).nullable().default(null),
});

const acceptInput = z.object({
  token: z.string(),
});

export const invitationsRouter = router({
  /**
   * `users:manage` gate is a simple in-procedure check, not a declarative per-endpoint permission
   * system (that's 003-06's larger, separate scope — a CI check asserting no handler lacks a
   * declaration — which doesn't exist yet and isn't built by this task). Scoped strictly to what
   * this endpoint needs.
   */
  create: protectedProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    if (!ctx.session.permissions.includes('users:manage')) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to invite members.' });
    }

    const invitationRepository = new InvitationRepository(ctx.db, ctx.session.organizationId);
    const { token } = await invitationRepository.create({
      email: input.email,
      role: input.role,
      storeIds: input.storeIds,
      invitedBy: ctx.session.userId,
    });

    return {
      message: 'Invitation created.',
      // TEMPORARY, same posture as signup's verification token: there is no email-sending
      // infrastructure anywhere in this project yet, so the raw token is returned directly rather
      // than emailed. Must be removed the moment there is somewhere to send it.
      _devOnlyInvitationToken: token.raw,
    };
  }),

  /**
   * The caller must already be signed in AND their own account's email must match the invitation's
   * invitee email — this is what prevents "accepting while logged in as a different user silently
   * switches accounts" (plan.md's explicitly named bug class). If the signed-in user's email
   * doesn't match, this is treated as a normal invalid-invitation error, not a distinct "wrong
   * account" message — telling an attacker "this invite is for a different email" would confirm
   * that email's association with this org, a real enumeration leak.
   */
  accept: protectedProcedure.input(acceptInput).mutation(async ({ ctx, input }) => {
    const invitation = await findInvitationByTokenHash(ctx.db, input.token);

    const genericError = () =>
      new TRPCError({ code: 'BAD_REQUEST', message: 'This invitation is invalid or has expired.' });

    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) {
      throw genericError();
    }

    const userRepository = new UserRepository(ctx.db);
    const caller = await userRepository.findById(ctx.session.userId);
    if (!caller || caller.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw genericError();
    }

    const result = await acceptInvitationByTokenHash(ctx.db, input.token, ctx.session.userId);
    if (!result) {
      // Lost a race with another acceptance of the same token between the check above and here —
      // the SQL function's own WHERE clause is the real, atomic guard; this is just surfacing that
      // outcome with the same generic message.
      throw genericError();
    }

    return { message: 'Invitation accepted.', organizationId: result.organizationId };
  }),
});
