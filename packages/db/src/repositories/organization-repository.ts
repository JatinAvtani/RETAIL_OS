import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { organizations } from '../schema/index';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Not a `TenantScopedRepository`: `organizations` has no `organization_id` column and no RLS
 * policy — it IS the tenant boundary, not a tenant-scoped row (see the schema file's own comment).
 * The organizationId this class is constructed with is the caller's own real boundary: `findMine`/
 * `updateMatchTolerances` always operate on exactly that row's id, never an id the caller supplies —
 * the same reasoning `InvoiceMatchRepository` uses for its own `this.organizationId` scoping,
 * applied here since RLS itself cannot help on a table with no tenant column to filter by.
 */
export class OrganizationRepository {
  private readonly db: Db;
  private readonly organizationId: string;

  constructor(db: Db, organizationId: string) {
    if (!organizationId || organizationId.trim().length === 0) {
      throw new Error('OrganizationRepository constructed without an organizationId.');
    }
    this.db = db;
    this.organizationId = organizationId;
  }

  async findMine() {
    const rows = await this.db.select().from(organizations).where(eq(organizations.id, this.organizationId));
    return rows[0] ?? null;
  }

  /**
   * each field is independently optional — `undefined` leaves the existing
   * column untouched, `null` explicitly clears an override back to
   * `DEFAULT_MATCH_TOLERANCES` for that one field. Never a bare "set everything," so an OWNER
   * tuning only the price tolerance doesn't accidentally reset quantity tolerance to null too.
   */
  async updateMatchTolerances(input: {
    matchPriceTolerancePercent?: string | null;
    matchPriceToleranceAbsolute?: string | null;
    matchQuantityTolerancePercent?: string | null;
  }): Promise<void> {
    const patch: Record<string, string | null> = {};
    if ('matchPriceTolerancePercent' in input) patch.matchPriceTolerancePercent = input.matchPriceTolerancePercent ?? null;
    if ('matchPriceToleranceAbsolute' in input) patch.matchPriceToleranceAbsolute = input.matchPriceToleranceAbsolute ?? null;
    if ('matchQuantityTolerancePercent' in input) patch.matchQuantityTolerancePercent = input.matchQuantityTolerancePercent ?? null;
    if (Object.keys(patch).length === 0) return;

    await this.db.update(organizations).set(patch).where(eq(organizations.id, this.organizationId));
  }
}
