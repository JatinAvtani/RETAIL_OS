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
import { csvImportRouter } from './routers/csv-import';
import { posItemsRouter } from './routers/pos-items';
import { dashboardRouter } from './routers/dashboard';
import { documentsRouter } from './routers/documents';
import { suppliersRouter } from './routers/suppliers';
import { purchaseOrdersRouter } from './routers/purchase-orders';
import { goodsReceiptsRouter } from './routers/goods-receipts';
import { invoiceMatchesRouter } from './routers/invoice-matches';
import { settingsRouter } from './routers/settings';
import { supplierPerformanceRouter } from './routers/supplier-performance';
import { searchRouter } from './routers/search';
import { assistantRouter } from './routers/assistant';

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
  csvImport: csvImportRouter,
  posItems: posItemsRouter,
  dashboard: dashboardRouter,
  documents: documentsRouter,
  suppliers: suppliersRouter,
  purchaseOrders: purchaseOrdersRouter,
  goodsReceipts: goodsReceiptsRouter,
  invoiceMatches: invoiceMatchesRouter,
  settings: settingsRouter,
  supplierPerformance: supplierPerformanceRouter,
  search: searchRouter,
  assistant: assistantRouter,
});

export type AppRouter = typeof appRouter;
