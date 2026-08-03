import { drizzle } from 'drizzle-orm/postgres-js';
import type { CurrencyCode } from '@retailos/domain';
import * as schema from '../schema/index';
import { UnmappedSaleRepository } from './unmapped-sale-repository';
import { SaleConsumptionService, type SaleConsumptionResult } from './sale-consumption-service';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type SalesIngestionResult =
  | { status: 'quarantined'; unmappedSaleId: string }
  | SaleConsumptionResult;

/**
 * 005-08 (spec 05 §5.1.3, plan.md Phase 4): the piece that sits one level BEFORE
 * `SaleConsumptionService.recordSaleConsumption` (005-07) in the pipeline description —
 * `sales.ingested → for each line: POSItem → MenuItem? NO → unmapped_sales quarantine ... YES →
 * record consumption`.
 *
 * Sales-source-agnostic, same confirmed scope as 005-07: `pos_items`/`sales_transactions` don't
 * exist yet (EPIC-006, not started), so this function has no opinion on HOW a POS item gets
 * mapped to a menu item — it only encodes the branch. `menuItemId` is `null` when the caller
 * (eventually EPIC-006's ingestion job, consulting its own `pos_items.mapping_status`) has no
 * mapping; this function then quarantines rather than guessing or dropping the sale line (I7).
 * Revenue is recorded on the quarantine row directly, independent of whether consumption ever
 * resolves — "revenue counts, consumption doesn't, nothing is silently dropped" (plan.md's exact
 * acceptance criterion), decoupling the two rather than blocking revenue recognition on a mapping.
 *
 * When `menuItemId` IS present, this delegates straight to `SaleConsumptionService` — the mapped
 * path is unchanged from 005-07, this function adds nothing on top of it.
 */
export class SalesIngestionPipeline {
  private readonly db: Db;
  private readonly organizationId: string;

  constructor(db: Db, organizationId: string) {
    if (!organizationId || organizationId.trim().length === 0) {
      throw new Error('SalesIngestionPipeline constructed without an organizationId.');
    }
    this.db = db;
    this.organizationId = organizationId;
  }

  async ingestSaleLine(input: {
    storeId: string;
    menuItemId: string | null;
    posItemExternalId: string;
    posItemName: string;
    quantitySold: string;
    revenue: string;
    currency: CurrencyCode;
    occurredAt: Date;
    sourceType: string;
    sourceId?: string;
    actorUserId?: string;
  }): Promise<SalesIngestionResult> {
    if (input.menuItemId === null) {
      const unmappedSaleRepository = new UnmappedSaleRepository(this.db, this.organizationId);
      const quarantined = await unmappedSaleRepository.quarantine({
        storeId: input.storeId,
        posItemExternalId: input.posItemExternalId,
        posItemName: input.posItemName,
        quantitySold: input.quantitySold,
        revenue: input.revenue,
        currency: input.currency,
        occurredAt: input.occurredAt,
        sourceType: input.sourceType,
        ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
      });
      return { status: 'quarantined', unmappedSaleId: quarantined.id };
    }

    const saleConsumptionService = new SaleConsumptionService(this.db, this.organizationId);
    return saleConsumptionService.recordSaleConsumption({
      storeId: input.storeId,
      menuItemId: input.menuItemId,
      quantitySold: input.quantitySold,
      occurredAt: input.occurredAt,
      currency: input.currency,
      sourceType: input.sourceType,
      ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
      ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
    });
  }
}
