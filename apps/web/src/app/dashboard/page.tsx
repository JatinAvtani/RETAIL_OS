'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
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
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui';

type Summary = Awaited<ReturnType<typeof trpc.dashboard.summary.query>>;

const PERIODS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

/** Formats a serialized money amount for display. Purely presentational — every figure here was already computed server-side by the metric catalog. */
const fmt = (m: { amount: string; currency: string } | null): string | null =>
  m === null ? null : `${m.currency} ${Number(m.amount).toFixed(2)}`;

const humanize = (value: string) => value.toLowerCase().replace(/_/g, ' ');

export default function DashboardPage() {
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedStoreId) return;
    setLoading(true);
    setError(null);
    trpc.dashboard.summary
      .query({ storeId: selectedStoreId, days })
      .then(setSummary)
      .catch(() => setError('Could not load the dashboard.'))
      .finally(() => setLoading(false));
  }, [selectedStoreId, days]);

  const variance = summary?.costVariance;
  const varianceTone =
    variance?.direction === 'over' ? 'danger' : variance?.direction === 'under' ? 'warning' : 'neutral';

  return (
    <>
      <PageHeader
        title="Overview"
        description="Where your margin actually went. Every figure below is computed from your own recorded sales, recipes, and stock movements — nothing is estimated."
        actions={
          <div className="flex items-center gap-2">
            {!storesLoading && stores.length > 0 && (
              <Select
                value={selectedStoreId}
                onChange={(e) => setSelectedStoreId(e.target.value)}
                className="w-auto"
              >
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
          <EmptyState title="No stores available." />
        </Card>
      )}

      {!loading && !error && summary && (
        <>
          {/* The headline row: what came in, what it cost, what's left. */}
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Net revenue"
              value={fmt(summary.netRevenue)}
              hint={`${summary.transactionCount} transactions`}
            />
            <StatTile
              label="Actual COGS"
              value={fmt(summary.cogsActual)}
              hint="From the lots stock was really drawn from"
              unknownReason={
                summary.completeness.unknownCostConsumptionEvents > 0
                  ? `${summary.completeness.unknownCostConsumptionEvents} consumption events have no known lot cost`
                  : 'Some consumed stock has no recorded cost'
              }
            />
            <StatTile
              label="Contribution margin"
              value={fmt(summary.contributionMargin)}
              tone="positive"
              hint={
                summary.contributionMarginPercentage !== null
                  ? `${summary.contributionMarginPercentage}% of revenue`
                  : 'Excludes rent, labour and tax'
              }
              unknownReason="Actual COGS could not be determined"
            />
            <StatTile
              label="Food cost"
              value={summary.foodCostPercentage !== null ? String(summary.foodCostPercentage) : null}
              unit="%"
              hint="COGS as a share of revenue"
              unknownReason="Needs both COGS and revenue"
            />
          </div>

          {/* Cost variance gets its own panel — it's the number almost nobody else can compute. */}
          <Card className="mb-6 overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-6 bg-surface-sunken/50 px-6 py-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-content-subtle">
                  Cost variance
                </p>
                {variance?.value === null ? (
                  <p className="mt-1.5 text-3xl font-semibold tracking-tight text-content-subtle">
                    Unknown
                  </p>
                ) : (
                  <p
                    className={`tabular mt-1.5 text-3xl font-semibold tracking-tight ${
                      varianceTone === 'danger'
                        ? 'text-danger'
                        : varianceTone === 'warning'
                          ? 'text-warning'
                          : 'text-content'
                    }`}
                  >
                    {fmt(variance?.value ?? null)}
                  </p>
                )}
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-sm text-content-muted">Actual</span>
                  <span className="tabular text-sm font-medium text-content">
                    {fmt(summary.cogsActual) ?? 'Unknown'}
                  </span>
                  <span className="text-sm text-content-subtle">vs theoretical</span>
                  <span className="tabular text-sm font-medium text-content">
                    {fmt(summary.cogsTheoretical) ?? 'Unknown'}
                  </span>
                </div>
              </div>

              <p className="max-w-md text-sm text-content-muted">
                {variance?.direction === 'over' && (
                  <>
                    You used <strong className="font-medium text-content">more</strong> stock than
                    your recipes account for. That gap is waste, over-portioning, or shrinkage —
                    losses that are invisible without both a recipe model and a stock ledger.
                  </>
                )}
                {variance?.direction === 'under' && (
                  <>
                    You used <strong className="font-medium text-content">less</strong> stock than
                    your recipes predict. Usually this means a recipe over-states its portions, or a
                    delivery was never recorded.
                  </>
                )}
                {variance?.direction === 'exact' && 'Actual consumption matched your recipes exactly.'}
                {variance?.direction === 'unknown' &&
                  'We can’t state this yet — it needs both a known actual cost and a fully-priced recipe for everything sold. We show nothing rather than a number we can’t stand behind.'}
              </p>
            </div>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Waste breakdown */}
            <Card>
              <CardHeader
                title="Waste by reason"
                actions={
                  <span className="tabular text-sm font-medium text-content">
                    {fmt(summary.waste.total) ?? 'Unknown'}
                  </span>
                }
              />
              {summary.waste.byReason.length === 0 ? (
                <EmptyState title="No waste recorded" hint="Nothing was logged in this period." />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Reason</Th>
                      <Th align="right">Value</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.waste.byReason.map((entry) => (
                      <Tr key={entry.reasonCode}>
                        <Td>{humanize(entry.reasonCode)}</Td>
                        <Td align="right" className="tabular">
                          {summary.currency} {Number(entry.value).toFixed(2)}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {summary.waste.unknownCostEventCount > 0 && (
                <p className="border-t border-border px-5 py-3 text-xs text-content-subtle">
                  {summary.waste.unknownCostEventCount} waste event
                  {summary.waste.unknownCostEventCount === 1 ? '' : 's'} had no known lot cost, so
                  the total above is incomplete.
                </p>
              )}
            </Card>

            {/* Data completeness — a trust feature, not an admission of weakness. */}
            <Card>
              <CardHeader title="Data completeness" />
              <Table>
                <tbody>
                  <Tr>
                    <Td>Sold lines from unmapped POS items</Td>
                    <Td align="right">
                      {summary.completeness.unmappedSoldLines === 0 ? (
                        <Badge tone="positive">All mapped</Badge>
                      ) : (
                        <Link href="/pos-items" className="text-sm font-medium text-accent hover:underline">
                          {summary.completeness.unmappedSoldLines} to map
                        </Link>
                      )}
                    </Td>
                  </Tr>
                  <Tr>
                    <Td>Consumption events with no known cost</Td>
                    <Td align="right">
                      {summary.completeness.unknownCostConsumptionEvents === 0 ? (
                        <Badge tone="positive">All costed</Badge>
                      ) : (
                        <Badge tone="warning">
                          {summary.completeness.unknownCostConsumptionEvents}
                        </Badge>
                      )}
                    </Td>
                  </Tr>
                  <Tr>
                    <Td>Units sold</Td>
                    <Td align="right" className="tabular">
                      {Number(summary.unitsSold).toFixed(0)}
                    </Td>
                  </Tr>
                  <Tr>
                    <Td>Average transaction value</Td>
                    <Td align="right" className="tabular">
                      {fmt(summary.averageTransactionValue) ?? '—'}
                    </Td>
                  </Tr>
                </tbody>
              </Table>
              <p className="border-t border-border px-5 py-3 text-xs text-content-subtle">
                Showing you what’s missing is the point — a number computed over incomplete data is
                only trustworthy if you know how incomplete it is.
              </p>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
