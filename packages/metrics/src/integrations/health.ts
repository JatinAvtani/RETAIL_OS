import type { PosConnectionStatus } from '@retailos/db';

/**
 * the metric catalog's registered functions for
 * integration health — status, `data_freshness_lag`, and the two data-completeness counts spec
 * 13  names explicitly ("23 POS items unmapped; consumption data is incomplete for these").
 * Pure, given already-fetched data (I2's own shape, matching `computeRecipeCost`'s precedent) — no
 * DB access here; `apps/api`'s router fetches via the existing repositories
 * (`PosConnectionRepository`/`PosItemRepository`/`UnmappedSaleRepository`) and passes the raw
 * counts/timestamps in. This task's numbers don't need the spec's full fact-table/caching
 * architecture () — a `COUNT(*)` and a timestamp subtraction have no aggregation pipeline to
 * build — but still go through ONE registered place, not an ad-hoc computation in the route
 * handler, so a future dashboard/AI-assistant caller has the same single source I2 requires.
 */

export type DataFreshnessLag = { status: 'never_synced' } | { status: 'known'; lagMinutes: number };

/**
 * `minutes since last successful POS sync`.
 * `'never_synced'` is a real, distinct state from "0 minutes" — a connection that has never
 * completed a sync has no lag to report, and reporting `0` would falsely read as "just synced"
 * (I7: absence of a signal is not evidence of freshness).
 */
export const computeDataFreshnessLag = (lastSuccessfulSyncAt: Date | null, now: Date): DataFreshnessLag => {
  if (!lastSuccessfulSyncAt) {
    return { status: 'never_synced' };
  }
  const lagMs = now.getTime() - lastSuccessfulSyncAt.getTime();
  return { status: 'known', lagMinutes: Math.max(0, Math.floor(lagMs / 60000)) };
};

export type IntegrationHealthErrorAction = { message: string; fixAction: string };

/**
 * the design's own literal example: "Reconnect Square — your authorization expired," never the
 * raw internal code. A narrow, explicit map — a status/error combination this function doesn't
 * recognize falls through to a generic-but-still-plain-language message, never the raw
 * `lastError` string verbatim (which may contain a vendor's own internal error code or stack
 * fragment, not something the spec's "customer's language" principle would consider readable).
 */
const errorActionFor = (status: PosConnectionStatus, lastError: string | null): IntegrationHealthErrorAction | null => {
  if (status === 'CONNECTED') return null;
  if (status === 'EXPIRED') {
    return { message: 'Your authorization expired.', fixAction: 'Reconnect Square' };
  }
  if (status === 'DISCONNECTED') {
    return { message: 'This integration is disconnected.', fixAction: 'Reconnect Square' };
  }
  if (status === 'FAILED' || status === 'DEGRADED') {
    return {
      message: lastError ?? 'The last sync did not complete successfully.',
      fixAction: 'Reconnect Square',
    };
  }
  return null;
};

export type IntegrationHealthSummary = {
  connectionId: string;
  storeId: string;
  status: PosConnectionStatus;
  freshness: DataFreshnessLag;
  unmappedItemCount: number;
  quarantineCount: number;
  error: IntegrationHealthErrorAction | null;
};

/**
 * The metric catalog's sole function for one connection's health summary (I2) — assembles the
 * already-fetched pieces (the design's exact fields: status, freshness, the data-completeness
 * indicator, a plain-language error+fix-action) into the one shape `apps/api`'s router returns.
 * Never computes a business number from raw rows itself — every input here is already a resolved
 * count or timestamp, matching I1's boundary even though no LLM is involved in this path.
 */
export const computeIntegrationHealthSummary = (input: {
  connectionId: string;
  storeId: string;
  status: PosConnectionStatus;
  lastError: string | null;
  lastSuccessfulSyncAt: Date | null;
  unmappedItemCount: number;
  quarantineCount: number;
  now: Date;
}): IntegrationHealthSummary => ({
  connectionId: input.connectionId,
  storeId: input.storeId,
  status: input.status,
  freshness: computeDataFreshnessLag(input.lastSuccessfulSyncAt, input.now),
  unmappedItemCount: input.unmappedItemCount,
  quarantineCount: input.quarantineCount,
  error: errorActionFor(input.status, input.lastError),
});
