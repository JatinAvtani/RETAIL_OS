import { createDb, findPendingInvitationsByEmail, MembershipRepository } from '@retailos/db';
import { permissionsForRole } from '@retailos/authz';
import type { SessionStore } from '@retailos/session';
import type { FastifyReply } from 'fastify';

type Db = ReturnType<typeof createDb>['db'];

export const SESSION_COOKIE_NAME = '__Host-session';

/** The one place the session cookie's flags are set — shared by password login and OAuth login. */
export const setSessionCookie = (res: FastifyReply, token: string): void => {
  res.setCookie(SESSION_COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
  });
};

export type SessionEstablishmentResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'no_accepted_membership' | 'multiple_organizations' };

/**
 * The "given an already-authenticated user, find their one accepted org membership and issue a
 * real session" step — shared by `auth.login` (password) and the Google OAuth callback, since both
 * reach the identical fork once a user's identity is established: multi-org accounts aren't
 * supported yet (no org-selection UI exists), so exactly one accepted membership is required.
 * Deliberately does not touch the response/cookie — that differs between a tRPC mutation (JSON) and
 * an OAuth callback (a 302 redirect), so callers handle transport themselves.
 *
 * `email` is needed for the zero-membership fallback below: a brand-new invitee has no accepted
 * membership yet (login would normally reject them the same as any zero-membership account), but
 * they need SOME session to ever call `invitations.accept` in the first place. If exactly one
 * pending invitation exists for this email, a minimal session scoped to that invitation's org is
 * issued instead, with an EMPTY permission set — `packages/authz`'s `hasPermission` denies
 * everything for an empty set by design (fail-closed), so this session can do nothing except what
 * `invitations.accept` itself allows (which doesn't check permissions), until the invite is
 * actually accepted and a real membership — and a real, permission-bearing session on the next
 * login — exists.
 */
export const establishSessionForUser = async (
  db: Db,
  sessionStore: SessionStore,
  userId: string,
  email: string,
  ip: string,
  userAgent: string
): Promise<SessionEstablishmentResult> => {
  const membershipRepository = new MembershipRepository(db);
  const acceptedMemberships = await membershipRepository.findAcceptedMembershipsForLogin(userId);

  if (acceptedMemberships.length === 0) {
    const pendingInvitations = await findPendingInvitationsByEmail(db, email);

    if (pendingInvitations.length === 1) {
      const invitation = pendingInvitations[0]!;
      const { token } = await sessionStore.create(
        {
          userId,
          organizationId: invitation.organizationId,
          storeIds: [],
          role: invitation.role,
          permissions: [],
        },
        ip,
        userAgent
      );
      return { ok: true, token };
    }

    return { ok: false, reason: 'no_accepted_membership' };
  }
  if (acceptedMemberships.length > 1) {
    return { ok: false, reason: 'multiple_organizations' };
  }

  const membership = acceptedMemberships[0]!;
  const { token } = await sessionStore.create(
    {
      userId,
      organizationId: membership.organizationId,
      storeIds: membership.storeIds ?? 'ALL',
      role: membership.role,
      permissions: [...permissionsForRole(membership.role)],
    },
    ip,
    userAgent
  );

  return { ok: true, token };
};
