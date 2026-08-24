'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { formatMoneyTotal } from '@/lib/format';
import { useStores } from '@/lib/use-stores';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  LoadingState,
  PageHeader,
  Select,
  StatTile,
  StatTileGrid,
  Table,
  Th,
  Td,
  Tr,
  Value,
} from '@/components/ui';

type ManagerSummary = Awaited<ReturnType<typeof trpc.dashboard.managerSummary.query>>;

const PERIODS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

/** Shared formatter, so INR groups the Indian way (lakh/crore) and no float is involved. */
const fmt = (m: { amount: string; currency: string } | null): string | null =>
  m === null ? null : formatMoneyTotal(m.amount, m.currency);

const humanizeStatus = (status: string) => status.toLowerCase().replace(/_/g, ' ');

/**
 * earlier work's real UI consumer — `dashboard.managerSummary` shipped with zero `apps/web` page in its
 * own session (API-only, confirmed as the real scope at the time). This closes that gap: the six
 * sections the design names for the manager dashboard, each a real number from the metric
 * catalog, laid out the same "stat tiles + cards" shape the owner dashboard (`/dashboard`) already
 * established rather than inventing a second visual language.
 *
 * `belowReorderPoint`/`expiryQueue` return raw `productId`/`lotId` rows with no human-readable name
 * (the endpoint's own real shape) — rather than a second lookup to resolve names here, each links
 * out to the existing dedicated page that already renders those rows with real names
 * (`/purchase-orders/suggestions`, `/inventory/lots`), matching the owner dashboard's own established
 * "surface the count, link elsewhere for the detail" pattern (its "unmapped POS items" row does the
 * same, linking to `/pos-items`).
 */
export default function ManagerDashboardPage() {
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<ManagerSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedStoreId) return;
    setLoading(true);
    setError(null);
    trpc.dashboard.managerSummary
      .query({ storeId: selectedStoreId, days })
      .then(setSummary)
      .catch(() => setError('Could not load the manager dashboard.'))
      .finally(() => setLoading(false));
  }, [selectedStoreId, days]);

  return (
    <>
      <PageHeader
        title="Manager view"
        description="What needs your attention today."
        actions={
          <div className="flex items-center gap-2">
            {!storesLoading && stores.length > 0 && (
              <Select value={selectedStoreId} onChange={(e) => setSelectedStoreId(e.target.value)} className="w-auto">
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </Select>
            )}
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-auto">
              {PERIODS.map((p) => (
                <option key={p.days} value={p.days}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      {(loading || storesLoading) && <LoadingState />}
      {!storesLoading && stores.length === 0 && (
        <Card>
          <EmptyState
            title="No stores available."
            hint="Every workspace gets a store when it's created, so this usually means your account isn't linked to one yet. Contact your workspace owner if this doesn't resolve after signing out and back in."
          />
        </Card>
      )}

      {!loading && !error && summary && (
        <>
          <StatTileGrid className="mb-6">
            <StatTile
              label="Today vs. trailing average"
              value={fmt(summary.todayVsAverage.today)}
              unknownReason="No priced sales recorded today"
              hint={
                summary.todayVsAverage.trailingDailyAverage
                  ? `avg ${fmt(summary.todayVsAverage.trailingDailyAverage)}/day over ${summary.period.days} days`
                  : 'No trailing average yet'
              }
              delta={{ direction: summary.todayVsAverage.direction, label: 'vs trailing average', higherIsBetter: true }}
            />
            {/* These are counts, so zero is a real and good value rather than an absence. The state
                rides in a badge beneath rather than recolouring the digit — see `StatTile`. */}
            <StatTile
              label="Below reorder point"
              value={String(summary.belowReorderPoint.count)}
              unknownReason="Reorder points could not be read"
              hint="Products at or under their reorder point"
              footer={
                <div className="mt-2.5">
                  <Badge tone={summary.belowReorderPoint.count > 0 ? 'warning' : 'positive'}>
                    {summary.belowReorderPoint.count > 0 ? 'Needs ordering' : 'All stocked'}
                  </Badge>
                </div>
              }
            />
            <StatTile
              label="Expiring stock, value at risk"
              value={formatMoneyTotal(String(summary.expiryQueue.totalValueAtRisk), summary.currency)}
              unknownReason="Lot costs could not be determined"
              hint={`${summary.expiryQueue.lots.length} lot${summary.expiryQueue.lots.length === 1 ? '' : 's'} expiring soon`}
              footer={
                Number(summary.expiryQueue.totalValueAtRisk) > 0 ? (
                  <div className="mt-2.5">
                    <Badge tone="warning">Use first</Badge>
                  </div>
                ) : null
              }
            />
            <StatTile
              label="Pending receipts"
              value={String(summary.pendingReceipts.count)}
              unknownReason="Purchase orders could not be read"
              hint="Sent purchase orders awaiting delivery"
            />
          </StatTileGrid>

          <div className="mb-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Below reorder point"
                actions={
                  <Link href="/purchase-orders/suggestions" className="text-sm font-medium text-accent hover:underline">
                    View reorder suggestions
                  </Link>
                }
              />
              {summary.belowReorderPoint.count === 0 ? (
                <EmptyState title="Nothing below its reorder point" hint="Every tracked product is stocked above its threshold." />
              ) : (
                <p className="px-5 py-4 text-sm text-content-muted">
                  {summary.belowReorderPoint.count} product{summary.belowReorderPoint.count === 1 ? '' : 's'} at or
                  under its reorder point — see reorder suggestions for what to order and from whom.
                </p>
              )}
            </Card>

            <Card>
              <CardHeader
                title="Expiry queue"
                actions={
                  <Link href="/inventory/lots" className="text-sm font-medium text-accent hover:underline">
                    View lots
                  </Link>
                }
              />
              {summary.expiryQueue.lots.length === 0 ? (
                <EmptyState title="Nothing expiring soon" hint="No lots are within the expiry risk window." />
              ) : (
                <p className="px-5 py-4 text-sm text-content-muted">
                  {summary.expiryQueue.lots.length} lot{summary.expiryQueue.lots.length === 1 ? '' : 's'} expiring
                  soon, {formatMoneyTotal(String(summary.expiryQueue.totalValueAtRisk), summary.currency)} of value at
                  risk — see lots for exact expiry dates.
                </p>
              )}
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Open purchase orders"
                actions={
                  <Link href="/purchase-orders/variance-queue" className="text-sm font-medium text-accent hover:underline">
                    Variance queue
                  </Link>
                }
              />
              <Table>
                <thead>
                  <tr>
                    <Th>Status</Th>
                    <Th align="right">Count</Th>
                  </tr>
                </thead>
                <tbody>
                  {summary.openPurchaseOrders.map((row) => (
                    <Tr key={row.status}>
                      <Td>{humanizeStatus(row.status)}</Td>
                      <Td variant="numeric">{row.count}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>

            <Card>
              <CardHeader
                title="Documents awaiting review"
                actions={
                  <Link href="/documents" className="text-sm font-medium text-accent hover:underline">
                    View documents
                  </Link>
                }
              />
              <Table>
                <tbody>
                  <Tr>
                    <Td>Awaiting review</Td>
                    <Td align="right">
                      {summary.documentsAwaitingReview.count === null ? (
                        <Badge tone="unknown">Not known</Badge>
                      ) : summary.documentsAwaitingReview.count === 0 ? (
                        <Badge tone="positive">None</Badge>
                      ) : (
                        <Badge tone="warning">{summary.documentsAwaitingReview.count}</Badge>
                      )}
                    </Td>
                  </Tr>
                  <Tr>
                    <Td>Oldest waiting</Td>
                    <Td variant="numeric">
                      <Value
                        value={
                          summary.documentsAwaitingReview.oldestAgeDays === null
                            ? null
                            : `${summary.documentsAwaitingReview.oldestAgeDays.toFixed(0)} day${summary.documentsAwaitingReview.oldestAgeDays === 1 ? '' : 's'}`
                        }
                      />
                    </Td>
                  </Tr>
                </tbody>
              </Table>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
