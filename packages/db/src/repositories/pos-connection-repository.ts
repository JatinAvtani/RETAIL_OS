import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { posConnections, type posConnectionStatusEnum } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';
import type { SalesSource } from './pos-item-repository';

export type PosConnectionStatus = (typeof posConnectionStatusEnum.enumValues)[number];

/**
 * 006-03's repository: `pos_connections` (one store's link to a vendor POS account). Stores/reads
 * `accessTokenCiphertext`/`refreshTokenCiphertext` opaquely — this class never encrypts or
 * decrypts anything itself, that's `packages/pos`'s `encryptToken`/`decryptToken` at the boundary
 * where the Fastify route/sync job actually needs the raw token, never left sitting decrypted in a
 * repository layer that has no reason to hold plaintext.
 */
export class PosConnectionRepository extends TenantScopedRepository<typeof posConnections> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, posConnections, organizationId);
  }

  /**
   * Upserts by the real `(store_id, vendor)` uniqueness constraint — reconnecting the same
   * store+vendor (e.g. after a token was revoked and the owner clicks "Connect Square" again)
   * replaces the old credentials in place rather than accumulating dead rows.
   */
  async upsert(input: {
    id: string;
    storeId: string;
    vendor: SalesSource;
    externalAccountId: string;
    externalLocationId?: string;
    accessTokenCiphertext: string;
    refreshTokenCiphertext?: string;
    tokenExpiresAt?: Date;
    connectedByUserId?: string;
  }) {
    const rows = await this.runScoped((db) =>
      db
        .insert(posConnections)
        .values({
          id: input.id,
          organizationId: this.organizationId,
          storeId: input.storeId,
          vendor: input.vendor,
          externalAccountId: input.externalAccountId,
          ...(input.externalLocationId !== undefined ? { externalLocationId: input.externalLocationId } : {}),
          accessTokenCiphertext: input.accessTokenCiphertext,
          ...(input.refreshTokenCiphertext !== undefined ? { refreshTokenCiphertext: input.refreshTokenCiphertext } : {}),
          ...(input.tokenExpiresAt !== undefined ? { tokenExpiresAt: input.tokenExpiresAt } : {}),
          status: 'CONNECTED',
          ...(input.connectedByUserId !== undefined ? { connectedByUserId: input.connectedByUserId } : {}),
        })
        .onConflictDoUpdate({
          target: [posConnections.storeId, posConnections.vendor],
          set: {
            externalAccountId: input.externalAccountId,
            ...(input.externalLocationId !== undefined ? { externalLocationId: input.externalLocationId } : {}),
            accessTokenCiphertext: input.accessTokenCiphertext,
            ...(input.refreshTokenCiphertext !== undefined ? { refreshTokenCiphertext: input.refreshTokenCiphertext } : {}),
            ...(input.tokenExpiresAt !== undefined ? { tokenExpiresAt: input.tokenExpiresAt } : {}),
            status: 'CONNECTED',
            lastError: null,
            disconnectedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning()
    );
    const row = rows[0];
    if (!row) {
      throw new Error('POS connection upsert returned no row.');
    }
    return row;
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(posConnections)
        .where(scopedWhere(eq(posConnections.id, id)))
    );
    return rows[0] ?? null;
  }

  async findByStoreAndVendor(storeId: string, vendor: SalesSource) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(posConnections)
        .where(scopedWhere(and(eq(posConnections.storeId, storeId), eq(posConnections.vendor, vendor))))
    );
    return rows[0] ?? null;
  }

  /** The integration health surface's read path (006-13) — every connection this org has, across all stores. */
  async findAllForOrganization() {
    return this.runScoped((db, scopedWhere) => db.select().from(posConnections).where(scopedWhere()));
  }

  async updateStatus(id: string, status: PosConnectionStatus, lastError?: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(posConnections)
        .set({ status, lastError: lastError ?? null, updatedAt: new Date() })
        .where(scopedWhere(eq(posConnections.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }

  async recordSuccessfulSync(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(posConnections)
        .set({ lastSuccessfulSyncAt: new Date(), status: 'CONNECTED', lastError: null, updatedAt: new Date() })
        .where(scopedWhere(eq(posConnections.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }

  /** Revokes locally — the caller (the disconnect endpoint, a later task) is responsible for also calling Square's own token-revocation endpoint before this. */
  async disconnect(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(posConnections)
        .set({ status: 'DISCONNECTED', disconnectedAt: new Date(), updatedAt: new Date() })
        .where(scopedWhere(eq(posConnections.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }
}
