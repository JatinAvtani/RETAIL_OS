import { createDb, stores } from '@retailos/db';
import { generateId } from '@retailos/domain';

type Db = ReturnType<typeof createDb>['db'];

/**
 * Task 003-13, spec 14 §14.3: "enumerate every registered route; for each, call with tenant B's
 * session against a tenant A resource id. Expect 403/404, never 200." This is the registry half of
 * that suite (see `cross-tenant.test.ts` for the runner) — a real, generic auto-attacker can't be
 * built without SOME per-endpoint knowledge, because there is no mechanical way to derive "what a
 * resource id looks like for this procedure" from a tRPC router alone (`stores.get` needs
 * `{ id: storeId }`; a hypothetical future `purchasing.get` might need `{ id: poId }`; an endpoint
 * with no resource id at all, like `invitations.create`, isn't in scope for THIS check — it has
 * nothing to attack by id).
 *
 * The reusable part — and what makes this "every future endpoint inherits it automatically" true
 * in practice — is the RUNNER, not this file. Adding cross-tenant coverage for a new endpoint is
 * one entry here (seed a resource, describe its shape), not a new hand-written test file.
 */
export type ResourceScopedProcedure = {
  /** Dotted tRPC path, e.g. 'stores.get'. */
  path: string;
  /** 'query' procedures are called via GET + ?input=; 'mutation' via POST + JSON body. */
  type: 'query' | 'mutation';
  /** Seeds a real resource belonging to `organizationId` and returns its id. */
  seedResource: (db: Db, organizationId: string) => Promise<string>;
  /** Builds the procedure's input given the (attacker-supplied) resource id. */
  buildInput: (resourceId: string) => Record<string, unknown>;
};

export const resourceScopedProcedures: ResourceScopedProcedure[] = [
  {
    path: 'stores.get',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const storeId = generateId();
      await db.insert(stores).values({
        id: storeId,
        organizationId,
        name: `Cross-tenant probe store ${storeId}`,
        timezone: 'America/New_York',
      });
      return storeId;
    },
    buildInput: (resourceId) => ({ id: resourceId }),
  },
];
