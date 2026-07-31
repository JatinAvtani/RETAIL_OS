import { createDb, MembershipRepository } from '@retailos/db';
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
 */
export const establishSessionForUser = async (
  db: Db,
  sessionStore: SessionStore,
  userId: string,
  ip: string,
  userAgent: string
): Promise<SessionEstablishmentResult> => {
  const membershipRepository = new MembershipRepository(db);
  const acceptedMemberships = await membershipRepository.findAcceptedMembershipsForLogin(userId);

  if (acceptedMemberships.length === 0) {
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
