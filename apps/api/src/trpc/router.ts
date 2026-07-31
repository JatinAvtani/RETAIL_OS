import { router } from './trpc';
import { authRouter } from './routers/auth';
import { invitationsRouter } from './routers/invitations';

export const appRouter = router({
  auth: authRouter,
  invitations: invitationsRouter,
});

export type AppRouter = typeof appRouter;
