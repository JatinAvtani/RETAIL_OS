import { initTRPC, TRPCError } from '@trpc/server';
import type { Context } from './context';

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

  return next({ ctx: { ...ctx, session } });
});
