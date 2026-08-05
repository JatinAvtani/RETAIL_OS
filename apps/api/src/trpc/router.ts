import { router } from './trpc';
import { authRouter } from './routers/auth';
import { invitationsRouter } from './routers/invitations';
import { storesRouter } from './routers/stores';
import { productsRouter } from './routers/products';
import { categoriesRouter } from './routers/categories';
import { unitsRouter } from './routers/units';
import { recipesRouter } from './routers/recipes';
import { inventoryRouter } from './routers/inventory';
import { stocktakeRouter } from './routers/stocktake';
import { integrationsRouter } from './routers/integrations';

export const appRouter = router({
  auth: authRouter,
  invitations: invitationsRouter,
  stores: storesRouter,
  products: productsRouter,
  categories: categoriesRouter,
  units: unitsRouter,
  recipes: recipesRouter,
  inventory: inventoryRouter,
  stocktake: stocktakeRouter,
  integrations: integrationsRouter,
});

export type AppRouter = typeof appRouter;
