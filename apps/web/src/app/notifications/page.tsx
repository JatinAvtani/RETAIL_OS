'use client';

import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import { Badge, Card, EmptyState, ErrorNotice, LoadingState, PageHeader, Select, StatTile, StatTileGrid, type BadgeTone } from '@/components/ui';
import { formatMoney, humanizeEnum } from '@/lib/format';

type Notification = Awaited<ReturnType<typeof trpc.notifications.list.query>>[number];

const SEVERITY_TONE: Record<string, BadgeTone> = {
  CRITICAL: 'danger',
  HIGH: 'danger',
  MEDIUM: 'warning',
  INFO: 'neutral',
};

const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 };

/**
 * The full-page notification centre. "Grouping" is presentational — the real collapsing of
 * multiple firings into one notification already happened server-side in
 * `aggregateNotificationContent`; this page groups the resulting real rows by severity for
 * scannability, not a second aggregation mechanism.
 *
 * Marking read happens on click, matching `NotificationBell`'s own convention — a notification
 * card is itself the "mark read" affordance, no separate button needed for the common case. "Mark
 * acted" is a distinct, explicit action (a "direct action link") since it records a genuinely
 * different fact — clicking through to actually do something about the alert — not merely having
 * seen it.
 */
export default function NotificationsPage() {
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [armedResolveId, setArmedResolveId] = useState<string | null>(null);

  const load = () => {
    if (!selectedStoreId) return;
    setLoading(true);
    setError(null);
    trpc.notifications.list
      .query({ storeId: selectedStoreId })
      .then(setNotifications)
      .catch(() => setError('Could not load notifications.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [selectedStoreId]);

  const markRead = (id: string) => {
    trpc.notifications.markRead
      .mutate({ id })
      .then(() => setNotifications((list) => list?.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)) ?? null))
      .catch(() => {});
  };

  const markActed = (id: string) => {
    trpc.notifications.markActed
      .mutate({ id })
      .then(() => setNotifications((list) => list?.map((n) => (n.id === id ? { ...n, actedAt: new Date().toISOString() } : n)) ?? null))
      .catch(() => {});
  };

  /**
   * `resolve` is a real, irreversible-feeling action — closing an alert a human decided is done
   * with, distinct from `markActed`'s "I clicked through" signal. Same armed-two-click pattern
   * `settings/page.tsx`'s session revoke already established for this codebase's one other
   * no-shared-confirm-dialog irreversible action: first click arms the row, a second click on the
   * SAME row actually resolves.
   */
  const resolve = (id: string) => {
    if (armedResolveId !== id) {
      setArmedResolveId(id);
      return;
    }
    setArmedResolveId(null);
    trpc.notifications.resolve
      .mutate({ id })
      .then(() => setNotifications((list) => list?.filter((n) => n.id !== id) ?? null))
      .catch(() => {});
  };

  const sorted = notifications
    ? [...notifications].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99))
    : null;

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Real, deduplicated alerts — a persistent problem updates in place rather than repeating; it resolves automatically once the condition clears."
        actions={
          stores.length > 1 ? (
            <Select value={selectedStoreId} onChange={(e) => setSelectedStoreId(e.target.value)} className="w-56">
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </Select>
          ) : undefined
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      {!storesLoading && !loading && !error && sorted !== null && sorted.length > 0 && (
        <StatTileGrid className="mb-6">
          <StatTile
            label="Unread"
            value={String(sorted.filter((n) => !n.readAt).length)}
            unknownReason="No notifications recorded yet"
          />
          <StatTile
            label="Critical / high"
            value={String(sorted.filter((n) => n.severity === 'CRITICAL' || n.severity === 'HIGH').length)}
            unknownReason="No notifications recorded yet"
          />
          <StatTile
            label="Not yet acted on"
            value={String(sorted.filter((n) => !n.actedAt).length)}
            unknownReason="No notifications recorded yet"
          />
          <StatTile
            label="Total at risk"
            value={formatMoney(
              sorted.reduce((sum, n) => sum + (n.dollarImpact !== null ? Number(n.dollarImpact) : 0), 0),
              undefined,
              { precision: 'currency' }
            )}
            hint="Sum of every alert's stated dollar impact"
            unknownReason="No notifications carry a dollar impact yet"
          />
        </StatTileGrid>
      )}

      <Card>
        {(storesLoading || loading) && <LoadingState label="Loading notifications…" />}

        {!storesLoading && !loading && !error && sorted !== null && sorted.length === 0 && (
          <EmptyState title="No active notifications" hint="Real alerts from stock, purchasing, and margin rules will appear here as they fire." />
        )}

        {!storesLoading && !loading && !error && sorted !== null && sorted.length > 0 && (
          <ul>
            {sorted.map((notification) => (
              <li
                key={notification.id}
                className={
                  'flex items-start justify-between gap-4 border-b border-border px-5 py-4 last:border-b-0 ' +
                  (!notification.readAt ? 'bg-accent-soft/30' : '')
                }
              >
                <button
                  type="button"
                  onClick={() => !notification.readAt && markRead(notification.id)}
                  className="flex min-w-0 flex-1 items-start gap-3 text-left"
                >
                  <Badge tone={SEVERITY_TONE[notification.severity] ?? 'neutral'}>
                    {humanizeEnum(notification.severity)}
                  </Badge>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-content">{notification.title}</span>
                    <span className="mt-0.5 block text-sm text-content-muted">{notification.body}</span>
                    <span className="mt-1 block text-xs text-content-subtle">
                      {new Date(notification.createdAt).toLocaleString()}
                      {notification.dollarImpact !== null && ` · ${formatMoney(notification.dollarImpact)} at risk`}
                    </span>
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  {!notification.actedAt ? (
                    <button
                      type="button"
                      onClick={() => markActed(notification.id)}
                      className="rounded-control border border-border-strong px-3 py-1.5 text-xs font-medium text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
                    >
                      Mark acted
                    </button>
                  ) : (
                    <span className="text-xs text-content-subtle">Acted</span>
                  )}
                  <button
                    type="button"
                    onClick={() => resolve(notification.id)}
                    aria-pressed={armedResolveId === notification.id}
                    className="rounded-control border border-border-strong px-3 py-1.5 text-xs font-medium text-content-muted transition-colors hover:border-danger/40 hover:bg-danger-soft hover:text-danger"
                  >
                    {armedResolveId === notification.id ? 'Confirm resolve?' : 'Resolve'}
                  </button>
                  {armedResolveId === notification.id && (
                    <span role="status" className="sr-only">
                      Click Resolve again to confirm — this cannot be undone.
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
