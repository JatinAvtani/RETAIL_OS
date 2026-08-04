import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

/**
 * 005-16: real HTTP verification for the inventory/stocktake routers, WITHOUT a live Redis
 * connection — this session's environment has Redis genuinely unreachable (a Windows/Docker
 * port-binding fault, unrelated to this code), so `protectedProcedure`'s session lookup can't be
 * exercised end to end here. What this file DOES prove, against a real running server and real
 * Postgres: every new procedure genuinely requires authentication (a bare, cookie-less request is
 * rejected with 401, not a crash or a silent pass), matching `protectedProcedure`'s documented
 * behavior. A full authenticated + cross-tenant suite (mirroring `cross-tenant.test.ts`'s existing
 * pattern for every other router) still needs writing and running once Redis is back — flagged
 * explicitly in progress notes, not silently treated as covered by this file alone.
 */
describe('inventory + stocktake routers — unauthenticated access', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const queryProcedures = [
    { path: 'inventory.levels', input: { storeId: '00000000-0000-0000-0000-000000000000' } },
    {
      path: 'inventory.movements',
      input: {
        storeId: '00000000-0000-0000-0000-000000000000',
        productId: '00000000-0000-0000-0000-000000000000',
        variantId: '00000000-0000-0000-0000-000000000000',
      },
    },
    {
      path: 'inventory.lots',
      input: { storeId: '00000000-0000-0000-0000-000000000000', productId: '00000000-0000-0000-0000-000000000000' },
    },
    { path: 'stocktake.get', input: { stockCountId: '00000000-0000-0000-0000-000000000000' } },
  ];

  it.each(queryProcedures)('$path rejects a request with no session cookie (401)', async ({ path, input }) => {
    const response = await app.inject({
      method: 'GET',
      url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
    });
    expect(response.statusCode).toBe(401);
  });

  const mutationProcedures = [
    {
      path: 'inventory.logWaste',
      input: {
        storeId: '00000000-0000-0000-0000-000000000000',
        productId: '00000000-0000-0000-0000-000000000000',
        variantId: '00000000-0000-0000-0000-000000000000',
        quantity: '1.000000',
        reasonCode: 'SPILLAGE',
      },
    },
    {
      path: 'inventory.logWasteFromLot',
      input: {
        storeId: '00000000-0000-0000-0000-000000000000',
        productId: '00000000-0000-0000-0000-000000000000',
        variantId: '00000000-0000-0000-0000-000000000000',
        lotId: '00000000-0000-0000-0000-000000000000',
        quantity: '1.000000',
        reasonCode: 'SPILLAGE',
      },
    },
    {
      path: 'stocktake.createFull',
      input: {
        storeId: '00000000-0000-0000-0000-000000000000',
        productVariantPairs: [
          { productId: '00000000-0000-0000-0000-000000000000', variantId: '00000000-0000-0000-0000-000000000000' },
        ],
      },
    },
    { path: 'stocktake.start', input: { stockCountId: '00000000-0000-0000-0000-000000000000' } },
    {
      path: 'stocktake.enterCount',
      input: { stockCountLineId: '00000000-0000-0000-0000-000000000000', countedQuantity: '1.000000' },
    },
    { path: 'stocktake.submit', input: { stockCountId: '00000000-0000-0000-0000-000000000000' } },
    { path: 'stocktake.approve', input: { stockCountId: '00000000-0000-0000-0000-000000000000' } },
    { path: 'stocktake.reject', input: { stockCountId: '00000000-0000-0000-0000-000000000000' } },
    {
      path: 'stocktake.setLineReason',
      input: { stockCountLineId: '00000000-0000-0000-0000-000000000000', reasonCode: 'test' },
    },
  ];

  it.each(mutationProcedures)('$path rejects a request with no session cookie (401)', async ({ path, input }) => {
    const response = await app.inject({
      method: 'POST',
      url: `/trpc/${path}`,
      payload: input,
    });
    expect(response.statusCode).toBe(401);
  });
});
