import { router } from './trpc';
import { authRouter } from './routers/auth';
import { invitationsRouter } from './routers/invitations';
import { storesRouter } from './routers/stores';

export const appRouter = router({
  auth: authRouter,
  invitations: invitationsRouter,
  stores: storesRouter,
});

export type AppRouter = typeof appRouter;
