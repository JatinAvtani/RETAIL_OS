import { describe, expect, it } from 'vitest';
import { computeDataFreshnessLag, computeIntegrationHealthSummary } from './health';

describe('computeDataFreshnessLag', () => {
  it('returns never_synced when no successful sync has ever completed', () => {
    const result = computeDataFreshnessLag(null, new Date('2026-08-06T12:00:00Z'));
    expect(result).toEqual({ status: 'never_synced' });
  });

  it('computes whole minutes elapsed since the last successful sync', () => {
    const lastSync = new Date('2026-08-06T11:30:00Z');
    const now = new Date('2026-08-06T12:00:00Z');
    const result = computeDataFreshnessLag(lastSync, now);
    expect(result).toEqual({ status: 'known', lagMinutes: 30 });
  });

  it('floors partial minutes rather than rounding', () => {
    const lastSync = new Date('2026-08-06T11:59:00Z');
    const now = new Date('2026-08-06T12:00:59Z'); // 1 minute 59 seconds elapsed
    const result = computeDataFreshnessLag(lastSync, now);
    expect(result).toEqual({ status: 'known', lagMinutes: 1 });
  });

  it('a sync that just completed reports 0 minutes, not never_synced', () => {
    const now = new Date('2026-08-06T12:00:00Z');
    const result = computeDataFreshnessLag(now, now);
    expect(result).toEqual({ status: 'known', lagMinutes: 0 });
  });

  it('never returns a negative lag even if lastSuccessfulSyncAt is somehow in the future (clock skew)', () => {
    const lastSync = new Date('2026-08-06T12:05:00Z');
    const now = new Date('2026-08-06T12:00:00Z');
    const result = computeDataFreshnessLag(lastSync, now);
    expect(result).toEqual({ status: 'known', lagMinutes: 0 });
  });
});

describe('computeIntegrationHealthSummary', () => {
  const now = new Date('2026-08-06T12:00:00Z');

  it('a healthy CONNECTED connection has no error', () => {
    const summary = computeIntegrationHealthSummary({
      connectionId: 'conn-1',
      storeId: 'store-1',
      status: 'CONNECTED',
      lastError: null,
      lastSuccessfulSyncAt: new Date('2026-08-06T11:45:00Z'),
      unmappedItemCount: 3,
      quarantineCount: 1,
      now,
    });
    expect(summary.error).toBeNull();
    expect(summary.freshness).toEqual({ status: 'known', lagMinutes: 15 });
    expect(summary.unmappedItemCount).toBe(3);
    expect(summary.quarantineCount).toBe(1);
  });

  it('an EXPIRED connection gets the spec\'s own literal example message and fix action', () => {
    const summary = computeIntegrationHealthSummary({
      connectionId: 'conn-1',
      storeId: 'store-1',
      status: 'EXPIRED',
      lastError: 'refresh_token_expired',
      lastSuccessfulSyncAt: new Date('2026-08-01T00:00:00Z'),
      unmappedItemCount: 0,
      quarantineCount: 0,
      now,
    });
    expect(summary.error).toEqual({ message: 'Your authorization expired.', fixAction: 'Reconnect Square' });
  });

  it('a DEGRADED connection surfaces the real lastError text as its plain-language message', () => {
    const summary = computeIntegrationHealthSummary({
      connectionId: 'conn-1',
      storeId: 'store-1',
      status: 'DEGRADED',
      lastError: 'Square orders sync failed: 500',
      lastSuccessfulSyncAt: new Date('2026-08-06T10:00:00Z'),
      unmappedItemCount: 0,
      quarantineCount: 0,
      now,
    });
    expect(summary.error?.message).toBe('Square orders sync failed: 500');
    expect(summary.error?.fixAction).toBe('Reconnect Square');
  });

  it('a FAILED connection with no lastError text falls back to a generic plain-language message, never a raw code', () => {
    const summary = computeIntegrationHealthSummary({
      connectionId: 'conn-1',
      storeId: 'store-1',
      status: 'FAILED',
      lastError: null,
      lastSuccessfulSyncAt: null,
      unmappedItemCount: 0,
      quarantineCount: 0,
      now,
    });
    expect(summary.error?.message).toBe('The last sync did not complete successfully.');
  });

  it('a DISCONNECTED connection reports its own distinct message', () => {
    const summary = computeIntegrationHealthSummary({
      connectionId: 'conn-1',
      storeId: 'store-1',
      status: 'DISCONNECTED',
      lastError: null,
      lastSuccessfulSyncAt: new Date('2026-07-01T00:00:00Z'),
      unmappedItemCount: 0,
      quarantineCount: 0,
      now,
    });
    expect(summary.error).toEqual({ message: 'This integration is disconnected.', fixAction: 'Reconnect Square' });
  });

  it('a connection that has never synced reports never_synced, not a fabricated lag', () => {
    const summary = computeIntegrationHealthSummary({
      connectionId: 'conn-1',
      storeId: 'store-1',
      status: 'CONNECTED',
      lastError: null,
      lastSuccessfulSyncAt: null,
      unmappedItemCount: 0,
      quarantineCount: 0,
      now,
    });
    expect(summary.freshness).toEqual({ status: 'never_synced' });
  });
});
