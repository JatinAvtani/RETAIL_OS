import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  acceptInvitationByTokenHash,
  findInvitationByTokenHash,
  InvitationRepository,
  MembershipListRepository,
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

const revokeInput = z.object({
  invitationId: z.string().uuid(),
});

const updateRoleInput = z.object({
  membershipId: z.string().uuid(),
  role: z.enum(['OWNER', 'MANAGER', 'STAFF', 'VIEWER_FINANCE']),
});

const removeMemberInput = z.object({
  membershipId: z.string().uuid(),
});

/** Same plain-array-check shape `documents.ts`'s own `requirePermission` established. */
const requireUsersManage = (permissions: readonly string[]) => {
  if (!permissions.includes('users:manage')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to manage team members.' });
  }
};

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

  /**
   * The team-management page's real read surface — genuinely missing until now (found while
   * building the UI: `invitations.create` existed with zero way to see who's already on the team
   * or who's still pending). Two separate lists, not one merged view — an accepted member and a
   * pending invitation are different real entities (a `memberships` row vs. an `invitations` row)
   * with different available actions (change role/remove vs. revoke), and conflating them would
   * blur that distinction in the UI.
   */
  listMembers: protectedProcedure.query(async ({ ctx }) => {
    requireUsersManage(ctx.session.permissions);
    const membershipListRepository = new MembershipListRepository(ctx.db, ctx.session.organizationId);
    return membershipListRepository.listAcceptedMembers();
  }),

  listPending: protectedProcedure.query(async ({ ctx }) => {
    requireUsersManage(ctx.session.permissions);
    const invitationRepository = new InvitationRepository(ctx.db, ctx.session.organizationId);
    return invitationRepository.listPending();
  }),

  revoke: protectedProcedure.input(revokeInput).mutation(async ({ ctx, input }) => {
    requireUsersManage(ctx.session.permissions);
    const invitationRepository = new InvitationRepository(ctx.db, ctx.session.organizationId);
    const revoked = await invitationRepository.revoke(input.invitationId);
    // NOT_FOUND, not BAD_REQUEST: revoke() is org-scoped (runScoped), so a cross-tenant invitationId
    // and an already-accepted/revoked one both come back null and are indistinguishable here — the
    // former must read as "not found," never as "bad state," or a cross-tenant call over-discloses
    // that the id exists at all (matches updateRole/removeMember's own NOT_FOUND convention below).
    if (!revoked) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Invitation not found.' });
    }
    return { message: 'Invitation revoked.' };
  }),

  /**
   * Refuses to demote the organization's LAST owner — a real guard, not cosmetic: an org with zero
   * accepted OWNER memberships has no one left who can invite, manage roles, or do anything
   * `users:manage` gates, a genuinely unrecoverable state through the UI (and close to it via the
   * API too, short of a manual DB fix).
   */
  updateRole: protectedProcedure.input(updateRoleInput).mutation(async ({ ctx, input }) => {
    requireUsersManage(ctx.session.permissions);
    const membershipListRepository = new MembershipListRepository(ctx.db, ctx.session.organizationId);

    if (input.role !== 'OWNER') {
      const members = await membershipListRepository.listAcceptedMembers();
      const target = members.find((m) => m.membershipId === input.membershipId);
      if (target?.role === 'OWNER') {
        const ownerCount = await membershipListRepository.countAcceptedOwners();
        if (ownerCount <= 1) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot change the role of the organization’s only owner.' });
        }
      }
    }

    const updated = await membershipListRepository.updateRole(input.membershipId, input.role);
    if (!updated) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found.' });
    }
    return { message: 'Role updated.' };
  }),

  removeMember: protectedProcedure.input(removeMemberInput).mutation(async ({ ctx, input }) => {
    requireUsersManage(ctx.session.permissions);
    const membershipListRepository = new MembershipListRepository(ctx.db, ctx.session.organizationId);

    const members = await membershipListRepository.listAcceptedMembers();
    const target = members.find((m) => m.membershipId === input.membershipId);
    if (target?.role === 'OWNER') {
      const ownerCount = await membershipListRepository.countAcceptedOwners();
      if (ownerCount <= 1) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot remove the organization’s only owner.' });
      }
    }

    const removed = await membershipListRepository.removeMember(input.membershipId);
    if (!removed) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found.' });
    }
    return { message: 'Member removed.' };
  }),
});
