import { z } from 'zod';
import { PosConnectionRepository, PosItemRepository } from '@retailos/db';
import { defineMetric, type MetricContext, type MetricResult } from '../catalog/index.js';
import { computeDataFreshnessLag } from './health.js';

/**
 * Operational health metrics for POS integrations. Both were already pure,
 * tested functions assembled into `computeIntegrationHealthSummary` but never individually
 * registered in the catalog — pure wrapper work, matching earlier work's precedent for pre-existing
 * compute logic. `unmapped_pos_items_count` reuses `PosItemRepository.findUnmapped` directly rather
 * than the volume-ranked variant, since a plain count needs no ranking.
 */

const storeParams = z.object({ storeId: z.string().uuid() });
type StoreParams = z.infer<typeof storeParams>;

const connectionParams = z.object({ connectionId: z.string().uuid() });
type ConnectionParams = z.infer<typeof connectionParams>;

/* ------------------------------------------------------------------ unmapped_pos_items_count */

export const unmappedPosItemsCountMetric = defineMetric<StoreParams>({
  id: 'unmapped_pos_items_count',
  description: 'Count of POS items with no menu-item mapping yet — consumption data is incomplete while this is high.',
  parameters: storeParams,
  unit: 'COUNT',
  requiredPermission: 'inventory:read',
  sources: ['pos_items'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const posItemRepository = new PosItemRepository(ctx.db, ctx.organizationId);
    const rows = await posItemRepository.findUnmapped(params.storeId);
    const now = new Date();
    return {
      metricId: 'unmapped_pos_items_count',
      value: String(rows.length),
      unit: 'COUNT',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'pos_items', rowCount: rows.length }],
    };
  },
});

/* ------------------------------------------------------------------ data_freshness_lag */

export const dataFreshnessLagMetric = defineMetric<ConnectionParams>({
  id: 'data_freshness_lag',
  description: 'Minutes since the last successful POS sync for one connection — a trust indicator for how current the data is.',
  parameters: connectionParams,
  unit: 'COUNT',
  requiredPermission: 'inventory:read',
  sources: ['pos_connections'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const posConnectionRepository = new PosConnectionRepository(ctx.db, ctx.organizationId);
    const connection = await posConnectionRepository.findById(params.connectionId);
    const now = new Date();
    if (!connection) {
      return {
        metricId: 'data_freshness_lag',
        value: 'unknown',
        unit: 'COUNT',
        period: { from: now, to: now },
        computedAt: now,
        freshness: now,
        provenance: [{ table: 'pos_connections', rowCount: 0 }],
        unknownReason: `POS connection '${params.connectionId}' not found.`,
      };
    }
    const lag = computeDataFreshnessLag(connection.lastSuccessfulSyncAt, now);
    return {
      metricId: 'data_freshness_lag',
      value: lag.status === 'never_synced' ? 'unknown' : String(lag.lagMinutes),
      unit: 'COUNT',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'pos_connections', rowCount: 1 }],
      ...(lag.status === 'never_synced' ? { unknownReason: 'This connection has never completed a successful sync.' } : {}),
    };
  },
});
