'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import {
  Badge,
  Button,
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
  Td,
  Th,
  Tr,
  Value,
} from '@/components/ui';

type Summary = Awaited<ReturnType<typeof trpc.dashboard.summary.query>>;
type DrillThroughResult = Awaited<ReturnType<typeof trpc.dashboard.drillThrough.query>>;
type DrillThroughFigure = Parameters<typeof trpc.dashboard.drillThrough.query>[0]['figure'];

const PERIODS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

/** Formats a serialized money amount for display. Purely presentational — every figure here was already computed server-side by the metric catalog. */
const fmt = (m: { amount: string; currency: string } | null): string | null =>
  m === null ? null : `${m.currency} ${Number(m.amount).toFixed(2)}`;

const humanize = (value: string) => value.toLowerCase().replace(/_/g, ' ');

/** Where each exception gets fixed — a "Needs attention" row without a destination is a dead end. */
const EXCEPTION_HREFS: Record<string, string> = {
  unmapped_pos_items_count: '/pos-items',
  documents_pending_review: '/documents',
  negative_stock_incidents: '/inventory',
  expiry_risk_value: '/inventory',
};

/** Only a fully-real series makes a real sparkline — one unknown point in the series and we show none, rather than a line with a fabricated gap. Returns an empty props object (not `{ trendPoints: undefined }`) so the JSX spread never explicitly assigns `undefined` to an optional prop under `exactOptionalPropertyTypes`. */
const trendProp = (points: (number | null)[]): { trendPoints: number[] } | Record<string, never> =>
  points.every((v) => v !== null) ? { trendPoints: points as number[] } : {};

/**
 * an inline expand/collapse drill-through, not a new modal component: clicking "Show
 * source rows" toggles a real row table fetched via `dashboard.drillThrough`, right under the
 * figure it belongs to. Deliberately lazy — the query only fires the first time a figure is
 * expanded, so figures nobody ever inspects cost nothing.
 */
const DrillThroughPanel = ({
  storeId,
  figure,
  from,
  to,
  reasonCode,
}: {
  storeId: string;
  figure: DrillThroughFigure;
  from: string;
  to: string;
  reasonCode?: string;
}) => {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<DrillThroughResult | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (result) return;
    setLoading(true);
    trpc.dashboard.drillThrough
      .query({ storeId, figure, from, to, ...(reasonCode ? { reasonCode } : {}) })
      .then(setResult)
      .finally(() => setLoading(false));
  };

  return (
    <div className="mt-2">
      <Button variant="ghost" className="px-2! py-1! text-xs" onClick={toggle}>
        {open ? 'Hide source rows' : 'Show source rows'}
      </Button>
      {open && (
        <div className="mt-2 rounded-lg border border-border">
          {loading && <p className="px-4 py-3 text-xs text-content-subtle">Loading…</p>}
          {!loading && result && result.rows.length === 0 && result.relatedFigures && (
            <p className="px-4 py-3 text-xs text-content-subtle">
              This figure combines {result.relatedFigures.join(' and ')} — expand those to see the
              real rows.
            </p>
          )}
          {!loading && result && result.rows.length === 0 && !result.relatedFigures && (
            <p className="px-4 py-3 text-xs text-content-subtle">No source rows in this period.</p>
          )}
          {!loading && result && result.rows.length > 0 && (
            <Table>
              <thead>
                <tr>
                  {'occurredAt' in result.rows[0]! && <Th>When</Th>}
                  <Th>Item</Th>
                  <Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <Tr key={row.id}>
                    {'occurredAt' in row && (
                      <Td className="text-xs text-content-subtle">
                        {new Date((row as { occurredAt: string }).occurredAt).toLocaleDateString()}
                      </Td>
                    )}
                    <Td>{row.label}</Td>
                    <Td variant="numeric">
                      <Value
                        value={row.amount ? `${row.amount.currency} ${Number(row.amount.amount).toFixed(2)}` : null}
                      />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      )}
    </div>
  );
};

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
        description="Where your margin went. Every figure is computed, not estimated."
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
          {/* The headline row: net revenue, contribution margin %, food cost %, stock value — each
              with delta + sparkline where a real trend exists. Edge-joined into one instrument panel
              rather than four detached cards; the drill-through trigger rides in each tile's own
              footer slot so the proof sits with the claim. */}
          <StatTileGrid className="mb-6">
            <StatTile
              label="Net revenue"
              value={fmt(summary.netRevenue)}
              hint={`${summary.transactionCount} transactions`}
              unknownReason="No priced sales were recorded in this period"
              {...trendProp(summary.trends.netRevenue)}
              delta={{ direction: summary.deltas.netRevenue.direction, label: `vs prior ${summary.period.days} days`, higherIsBetter: true }}
              footer={
                summary.netRevenue !== null && selectedStoreId ? (
                  <DrillThroughPanel storeId={selectedStoreId} figure="net_revenue" from={summary.period.from} to={summary.period.to} />
                ) : null
              }
            />
            <StatTile
              label="Contribution margin"
              value={
                summary.contributionMarginPercentage !== null ? String(summary.contributionMarginPercentage) : null
              }
              unit="%"
              hint="Excludes rent, labour and tax"
              unknownReason={summary.unknownReasons.contributionMarginPercentage ?? 'Actual COGS could not be determined'}
              delta={{
                direction: summary.deltas.contributionMarginPercentage.direction,
                label: `vs prior ${summary.period.days} days`,
                higherIsBetter: true,
              }}
              footer={
                summary.contributionMarginPercentage !== null && selectedStoreId ? (
                  <DrillThroughPanel storeId={selectedStoreId} figure="contribution_margin" from={summary.period.from} to={summary.period.to} />
                ) : null
              }
            />
            <StatTile
              label="Food cost"
              value={summary.foodCostPercentage !== null ? String(summary.foodCostPercentage) : null}
              unit="%"
              hint="COGS as a share of revenue"
              unknownReason={summary.unknownReasons.foodCostPercentage ?? 'Needs both COGS and revenue'}
              {...trendProp(summary.trends.foodCostPercentage)}
              delta={{ direction: summary.deltas.foodCostPercentage.direction, label: `vs prior ${summary.period.days} days`, higherIsBetter: false }}
              footer={
                summary.foodCostPercentage !== null && selectedStoreId ? (
                  <DrillThroughPanel storeId={selectedStoreId} figure="food_cost_percentage" from={summary.period.from} to={summary.period.to} />
                ) : null
              }
            />
            <StatTile
              label="Stock value"
              value={fmt(summary.stockValue)}
              hint="Cash tied up in on-hand stock, right now"
              unknownReason="You need inventory:read to see this"
              footer={
                summary.stockValue !== null && selectedStoreId ? (
                  <DrillThroughPanel storeId={selectedStoreId} figure="stock_value" from={summary.period.from} to={summary.period.to} />
                ) : null
              }
            />
          </StatTileGrid>

          {/* The exception feed — deterministic, computed from the same registered metrics as
              everything else. Each row links to the screen where the problem gets fixed: a card
              that names a problem but goes nowhere makes the reader do the routing themselves. */}
          {summary.exceptions.length > 0 && (
            <Card className="mb-6">
              <CardHeader title="Needs attention" />
              <ul className="divide-y divide-border">
                {summary.exceptions.map((exception) => {
                  const href = EXCEPTION_HREFS[exception.id];
                  const row = (
                    <>
                      <Badge tone={exception.severity === 'danger' ? 'danger' : 'warning'}>
                        {exception.severity === 'danger' ? 'Urgent' : 'Review'}
                      </Badge>
                      <span className="text-sm text-content">{exception.label}</span>
                    </>
                  );
                  return (
                    <li key={exception.id}>
                      {href ? (
                        <Link href={href} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-sunken">
                          {row}
                        </Link>
                      ) : (
                        <div className="flex items-center gap-3 px-5 py-3">{row}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {summary.itemsByContribution !== null && summary.itemsByContribution.length > 0 && (
            <div className="mb-6 grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader title="Top items by contribution" />
                <Table>
                  <thead>
                    <tr>
                      <Th>Item</Th>
                      <Th align="right">Total contribution</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.itemsByContribution.slice(0, 5).map((item) => (
                      <Tr key={item.menuItemId}>
                        <Td>{item.menuItemName}</Td>
                        <Td variant="numeric">
                          <Value value={fmt(item.totalContribution)} />
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
              <Card>
                <CardHeader title="Bottom items by contribution" />
                <Table>
                  <thead>
                    <tr>
                      <Th>Item</Th>
                      <Th align="right">Total contribution</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...summary.itemsByContribution]
                      .reverse()
                      .slice(0, 5)
                      .map((item) => (
                        <Tr key={item.menuItemId}>
                          <Td>{item.menuItemName}</Td>
                          <Td variant="numeric">
                            <Value value={fmt(item.totalContribution)} />
                          </Td>
                        </Tr>
                      ))}
                  </tbody>
                </Table>
              </Card>
            </div>
          )}

          {/* Cost variance gets its own panel — it's the number almost nobody else can compute. */}
          <Card className="mb-6 overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-6 bg-surface-sunken/50 px-6 py-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-content-subtle">
                  Cost variance
                </p>
                {variance?.value === null ? (
                  <>
                    <p className="mt-2 text-2xl italic leading-none text-unknown">Not known</p>
                    <p className="mt-2 text-xs text-content-subtle">
                      Needs both a known actual cost and a fully-priced recipe for everything sold
                    </p>
                  </>
                ) : (
                  <div className="mt-2 flex flex-wrap items-baseline gap-2.5">
                    {/* The figure stays ink-coloured; the direction it moved is carried by the badge
                        beside it. A red number invites reading the colour instead of the digit, and
                        this is the digit the whole product exists to produce. */}
                    <p className="font-mono text-3xl font-semibold leading-none tracking-[-0.02em] tabular-nums text-content">
                      {fmt(variance?.value ?? null)}
                    </p>
                    {varianceTone !== 'neutral' && (
                      <Badge tone={varianceTone === 'danger' ? 'danger' : 'warning'}>
                        {variance?.direction === 'over' ? 'Over recipe' : 'Under recipe'}
                      </Badge>
                    )}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-baseline gap-2 text-sm">
                  <span className="text-content-muted">Actual</span>
                  <span className="font-medium text-content">
                    <Value value={fmt(summary.cogsActual)} />
                  </span>
                  <span className="text-content-subtle">vs theoretical</span>
                  <span className="font-medium text-content">
                    <Value value={fmt(summary.cogsTheoretical)} />
                  </span>
                </div>
                {summary.cogsActual !== null && selectedStoreId && (
                  <DrillThroughPanel storeId={selectedStoreId} figure="cogs_actual" from={summary.period.from} to={summary.period.to} />
                )}
              </div>

              <p className="max-w-md text-sm text-content-muted">
                {variance?.direction === 'over' && (
                  <>
                    You used <strong className="font-medium text-content">more</strong> stock than your
                    recipes call for. This is likely waste, over-portioning, or theft.
                  </>
                )}
                {variance?.direction === 'under' && (
                  <>
                    You used <strong className="font-medium text-content">less</strong> stock than your
                    recipes call for. Check if a recipe or a delivery needs fixing.
                  </>
                )}
                {variance?.direction === 'exact' && 'Actual usage matched your recipes exactly.'}
                {variance?.direction === 'unknown' &&
                  (summary.unknownReasons.costVariance ??
                    'Not enough data yet — we need real costs and priced recipes for everything sold.')}
              </p>
            </div>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Waste breakdown */}
            <Card>
              <CardHeader
                title="Waste by reason"
                actions={
                  <span className="text-sm font-medium text-content">
                    <Value value={fmt(summary.waste.total)} />
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
                        <Td className="capitalize">{humanize(entry.reasonCode)}</Td>
                        <Td variant="numeric">
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
                  {summary.waste.unknownCostEventCount === 1 ? '' : 's'} had no known cost, so this
                  total is not complete.
                </p>
              )}
              {summary.waste.byReason.length > 0 && selectedStoreId && (
                <div className="border-t border-border px-5 py-3">
                  <DrillThroughPanel storeId={selectedStoreId} figure="waste_total" from={summary.period.from} to={summary.period.to} />
                </div>
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
                    <Td variant="numeric">{Number(summary.unitsSold).toFixed(0)}</Td>
                  </Tr>
                  <Tr>
                    <Td>Average transaction value</Td>
                    {/* An em-dash here would read as a value. It isn't one — this is genuinely
                        unknown whenever revenue or the transaction count is, so it renders through
                        `Value` like every other nullable figure. */}
                    <Td variant="numeric">
                      <Value value={fmt(summary.averageTransactionValue)} />
                    </Td>
                  </Tr>
                </tbody>
              </Table>
              <p className="border-t border-border px-5 py-3 text-xs text-content-subtle">
                We show you what's missing so you know how much to trust the numbers above.
              </p>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
