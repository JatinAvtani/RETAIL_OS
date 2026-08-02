import { router } from './trpc';
import { authRouter } from './routers/auth';
import { invitationsRouter } from './routers/invitations';
import { storesRouter } from './routers/stores';
import { productsRouter } from './routers/products';
import { categoriesRouter } from './routers/categories';
import { unitsRouter } from './routers/units';
import { recipesRouter } from './routers/recipes';

export const appRouter = router({
  auth: authRouter,
  invitations: invitationsRouter,
  stores: storesRouter,
  products: productsRouter,
  categories: categoriesRouter,
  units: unitsRouter,
  recipes: recipesRouter,
});

export type AppRouter = typeof appRouter;
