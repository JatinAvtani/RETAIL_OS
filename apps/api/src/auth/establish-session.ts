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
 * Marks a session as belonging to a user who has authenticated but does not yet have a workspace —
 * a Google sign-in by someone who has never used the product before.
 *
 * Held in the session's `organizationId` slot as a sentinel rather than as a separate field because
 * every consumer already treats that value as "the tenant this session may touch"; a real org id
 * can never collide with it, and any tenant-scoped query built from it fails closed rather than
 * silently reading another tenant's rows. Combined with an empty permission set (which
 * `packages/authz`'s `hasPermission` denies everything for, by design), a provisioning session can
 * do precisely one thing: call `auth.completeGoogleSignup`.
 */
export const PROVISIONING_ORGANIZATION_ID = '__provisioning__';

/**
 * Issues the minimal session described above.
 *
 * This exists because Google sign-in has a case password login does not: `resolveGoogleUser`
 * CREATES a real, email-verified `users` row for an unrecognised Google identity, and that row is
 * committed before anyone knows whether a membership exists. Previously the caller then discovered
 * there was none, redirected to /login with an error, and left the row behind — an account that
 * owned the person's email address, could never sign in, and blocked them from signing up properly
 * with the same address. A dead end reachable in one click.
 *
 * Rather than refuse to create the user (which would make Google sign-in work only for people who
 * had already registered with a password — not what anyone means by "use my Google account"), the
 * account is kept and finished: this session lets exactly one procedure run, the one that creates
 * the workspace Google cannot supply.
 */
export const createProvisioningSession = async (
  sessionStore: SessionStore,
  userId: string,
  ip: string,
  userAgent: string
): Promise<string> => {
  const { token } = await sessionStore.create(
    {
      userId,
      organizationId: PROVISIONING_ORGANIZATION_ID,
      storeIds: [],
      // OWNER is the role this user will genuinely hold once their workspace exists
      // (`createOrganizationWithOwner` assigns it), but it grants nothing here: permissions is empty
      // and `hasPermission` fails closed, so the role is a record of intent, not of authority.
      role: 'OWNER',
      permissions: [],
    },
    ip,
    userAgent
  );
  return token;
};

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
