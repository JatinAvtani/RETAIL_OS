import { initTRPC, TRPCError } from '@trpc/server';
import type { Context } from './context';
import { PROVISIONING_ORGANIZATION_ID } from '../auth/establish-session';

const SESSION_COOKIE_NAME = '__Host-session';

const t = initTRPC.context<Context>().create({
  // Stack traces are useful in local dev but must never reach a real client — leaking internal
  // file paths and call stacks is an information-disclosure issue, not a cosmetic one.
  errorFormatter: ({ shape }) => ({
    ...shape,
    data: {
      ...shape.data,
      stack: undefined,
    },
  }),
});

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Resolves the session cookie into a real, currently-valid session (a stolen/expired/never-issued
 * cookie is rejected the same as no cookie at all — no information gained either way). Not
 * resolved eagerly for every request in `createContext`: most procedures today are public and
 * don't need it, so doing so unconditionally would be a wasted Redis round trip on every request.
 * `ctx.session` carries the raw `SessionRecord` shape (permissions as an array, no `approvalLimit`
 * as `Money` yet) — building a full `packages/authz` `AuthContext` from it, with `Money` conversion
 * and a `Set`, is deferred until an endpoint actually needs `canApproveAmount`; nothing does yet.
 */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  const token = ctx.req.cookies[SESSION_COOKIE_NAME];
  const session = token ? await ctx.sessionStore.get(token) : null;

  if (!session) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not signed in.' });
  }

  /*
   * A provisioning session (Google sign-in by someone with no workspace yet) authenticates a real
   * person but is not yet scoped to any tenant. Rejected explicitly here rather than left to fail
   * downstream: 231 call sites read `ctx.session.organizationId` and hand it straight to a
   * repository, and while every one of those WOULD fail closed — the sentinel matches no rows and
   * RLS refuses the writes — "the query happens to return nothing" is not a defensible auth
   * boundary. The check belongs at the gate, once, where it is visible.
   */
  if (session.organizationId === PROVISIONING_ORGANIZATION_ID) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Finish setting up your workspace first.',
    });
  }

  return next({ ctx: { ...ctx, session, sessionToken: token as string } });
});

/**
 * The one procedure kind a provisioning session may use: authenticated, but deliberately NOT
 * tenant-scoped, because the caller has no tenant yet. Used only by `auth.completeGoogleSignup`.
 *
 * Rejects a fully-provisioned session for the mirror-image reason `protectedProcedure` rejects a
 * provisioning one — someone who already has a workspace must not be able to mint a second one
 * through this path.
 */
export const provisioningProcedure = t.procedure.use(async ({ ctx, next }) => {
  const token = ctx.req.cookies[SESSION_COOKIE_NAME];
  const session = token ? await ctx.sessionStore.get(token) : null;

  if (!session) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not signed in.' });
  }

  if (session.organizationId !== PROVISIONING_ORGANIZATION_ID) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'This account already has a workspace.' });
  }

  return next({ ctx: { ...ctx, session, sessionToken: token as string } });
});
