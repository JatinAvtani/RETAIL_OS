'use client';

import { useCallback, useEffect, useState } from 'react';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { humanizeEnum } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  LoadingState,
  PageHeader,
  StatTile,
  StatTileGrid,
  Table,
  Td,
  Th,
  Tr,
  Value,
  type BadgeTone,
} from '@/components/ui';

type Store = Awaited<ReturnType<typeof trpc.stores.list.query>>[number];
type HealthSummary = Awaited<ReturnType<typeof trpc.integrations.health.query>>[number];

const STATUS_TONES: Record<HealthSummary['status'], BadgeTone> = {
  CONNECTED: 'positive',
  EXPIRED: 'warning',
  DISCONNECTED: 'neutral',
  FAILED: 'danger',
  DEGRADED: 'warning',
};

const describeFreshness = (freshness: HealthSummary['freshness']) => {
  if (freshness.status === 'never_synced') return 'Never synced';
  if (freshness.lagMinutes < 60) return `${freshness.lagMinutes}m ago`;
  const hours = Math.floor(freshness.lagMinutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};

/**
 * earlier work's own health metric had zero UI anywhere until now (a real gap the audit found —
 * `integrations.health`/`syncSquareCatalog`/`syncSquareOrders`/`reconcileSquareOrders` all existed,
 * exercised only by tests). Org-wide, not store-scoped, matching `health`'s own return shape: every
 * store the caller can see, each either showing its connection's real status/freshness/error or an
 * explicit "not connected" state with a real Connect link (`/integrations/square/connect` is a
 * plain redirect, not a tRPC mutation — Square's OAuth flow requires a real browser navigation).
 */
export default function IntegrationsPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [health, setHealth] = useState<HealthSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyStoreId, setBusyStoreId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([trpc.stores.list.query(), trpc.integrations.health.query()])
      .then(([storeList, healthList]) => {
        setStores(storeList);
        setHealth(healthList);
      })
      .catch(() => setError('Could not load integration status.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const runAction = async (
    storeId: string,
    label: string,
    action: () => Promise<{ recordsProcessed?: number } | unknown>
  ) => {
    setBusyStoreId(storeId);
    setActionMessage(null);
    setError(null);
    try {
      await action();
      setActionMessage(`${label} completed.`);
      load();
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : `${label} failed.`;
      setError(message);
    } finally {
      setBusyStoreId(null);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title="Integrations" />
        <Card>
          <LoadingState />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Your POS connection for each store."
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}
      {actionMessage && (
        <div className="mb-4 rounded-card border border-positive/30 bg-positive-soft px-4 py-3 text-sm text-positive">
          {actionMessage}
        </div>
      )}

      {stores.length > 0 && (
        <StatTileGrid className="mb-6">
          <StatTile
            label="Connected"
            value={String(health.filter((h) => h.status === 'CONNECTED').length)}
            unknownReason="No stores available"
          />
          <StatTile
            label="Expired or degraded"
            value={String(health.filter((h) => h.status === 'EXPIRED' || h.status === 'DEGRADED').length)}
            unknownReason="No stores available"
          />
          <StatTile
            label="Failed"
            value={String(health.filter((h) => h.status === 'FAILED').length)}
            unknownReason="No stores available"
          />
          <StatTile
            label="Not connected"
            value={String(stores.length - health.length)}
            unknownReason="No stores available"
          />
        </StatTileGrid>
      )}

      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Store</Th>
              <Th>Status</Th>
              <Th>Last synced</Th>
              <Th>Data completeness</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {stores.map((store) => {
              const connectionHealth = health.find((h) => h.storeId === store.id);
              const busy = busyStoreId === store.id;

              return (
                <Tr key={store.id}>
                  <Td className="font-medium">{store.name}</Td>
                  <Td>
                    {connectionHealth ? (
                      <div className="space-y-1">
                        <Badge tone={STATUS_TONES[connectionHealth.status]}>
                          {humanizeEnum(connectionHealth.status)}
                        </Badge>
                        {connectionHealth.error && (
                          <p className="text-xs text-danger">{connectionHealth.error.message}</p>
                        )}
                      </div>
                    ) : (
                      <Badge tone="neutral">Not connected</Badge>
                    )}
                  </Td>
                  <Td className="text-content-muted">
                    <Value value={connectionHealth ? describeFreshness(connectionHealth.freshness) : null} />
                  </Td>
                  <Td className="text-content-muted">
                    {connectionHealth ? (
                      connectionHealth.unmappedItemCount === 0 && connectionHealth.quarantineCount === 0 ? (
                        <Badge tone="positive">All clean</Badge>
                      ) : (
                        <>
                          {connectionHealth.unmappedItemCount > 0 && (
                            <span className="mr-2">{connectionHealth.unmappedItemCount} unmapped items</span>
                          )}
                          {connectionHealth.quarantineCount > 0 && (
                            <span>{connectionHealth.quarantineCount} quarantined sales</span>
                          )}
                        </>
                      )
                    ) : (
                      <Value value={null} />
                    )}
                  </Td>
                  <Td align="right">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {!connectionHealth || connectionHealth.status !== 'CONNECTED' ? (
                        <a href={`/integrations/square/connect?storeId=${store.id}`}>
                          <Button type="button" variant="primary">
                            {connectionHealth ? 'Reconnect' : 'Connect'} Square
                          </Button>
                        </a>
                      ) : (
                        <>
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={busy}
                            onClick={() =>
                              runAction(store.id, 'Catalog sync', () =>
                                trpc.integrations.syncSquareCatalog.mutate({ storeId: store.id })
                              )
                            }
                          >
                            {busy ? 'Working…' : 'Sync catalog'}
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={busy}
                            onClick={() =>
                              runAction(store.id, 'Orders sync', () =>
                                trpc.integrations.syncSquareOrders.mutate({ storeId: store.id })
                              )
                            }
                          >
                            {busy ? 'Working…' : 'Sync orders'}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              runAction(store.id, 'Reconciliation sweep', () =>
                                trpc.integrations.reconcileSquareOrders.mutate({ storeId: store.id })
                              )
                            }
                          >
                            {busy ? 'Working…' : 'Reconcile'}
                          </Button>
                        </>
                      )}
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
