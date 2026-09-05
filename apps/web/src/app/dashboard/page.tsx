'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import { formatMoneyTotal } from '@/lib/format';
import {
  Badge,
  BarComparison,
  Button,
  Card,
  CardHeader,
  cx,
  DivergingBar,
  MarginWaterfall,
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
type OnboardingProgress = Awaited<ReturnType<typeof trpc.onboarding.getProgress.query>>;

/** The four real, independently-skippable wizard steps `onboarding_progress` tracks. Any one still `PENDING` means setup genuinely isn't finished — a `SKIPPED` step is a real decision the user already made, so it must NOT keep the prompt alive. */
const ONBOARDING_STEPS = [
  'salesConnectedStatus',
  'invoicesUploadedStatus',
  'entitiesConfirmedStatus',
  'parLevelsSetStatus',
] as const;
type DrillThroughResult = Awaited<ReturnType<typeof trpc.dashboard.drillThrough.query>>;
type DrillThroughFigure = Parameters<typeof trpc.dashboard.drillThrough.query>[0]['figure'];

const PERIODS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

/** Formats a serialized money amount for display. Purely presentational — every figure here was already computed server-side by the metric catalog. */
/**
 * Delegates to the shared `formatMoney` rather than doing its own `Number(...).toFixed(2)`, which
 * this previously did and which was wrong twice over: it dropped digit grouping entirely (an INR
 * figure rendered as `2304500.00`, unreadable at a glance), and it round-tripped an exact decimal
 * string through a float on the way. `formatMoney` groups by the CURRENCY's own convention — Indian
 * lakh/crore for INR — and never touches a float.
 */
const fmt = (m: { amount: string; currency: string } | null): string | null =>
  m === null ? null : formatMoneyTotal(m.amount, m.currency);

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

type Provenance = NonNullable<Summary['provenance']['netRevenue']>;

/**
 * One disclosure per tile, not two. Provenance ("why is this number true") and source rows
 * ("what rows made it") used to be separate buttons, each with its own inline `disclosure-grid`
 * — permanent footer space in every tile plus, once opened, a full-width table nested inside a
 * quarter-width grid column, which is what caused the horizontal overflow. Folding both under one
 * "Details" toggle on the tile itself keeps the closed state to a single line and gives the
 * expanded content the tile's full stretched width to lay out in, instead of stacking two
 * independently-animated panels.
 */
const TileDetailPanel = ({
  open,
  provenance,
  storeId,
  figure,
  from,
  to,
  reasonCode,
}: {
  open: boolean;
  provenance: Provenance | null;
  storeId: string;
  figure: DrillThroughFigure;
  from: string;
  to: string;
  reasonCode?: string;
}) => {
  const [result, setResult] = useState<DrillThroughResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || result || loading) return;
    setLoading(true);
    trpc.dashboard.drillThrough
      .query({ storeId, figure, from, to, ...(reasonCode ? { reasonCode } : {}) })
      .then(setResult)
      .finally(() => setLoading(false));
    // Deliberately lazy — the query only fires the first time the tile is opened, so figures
    // nobody ever inspects cost nothing. `result` staying set after close is what lets a re-open
    // skip the network round trip. Deps are `[open]` only, not the query params — those are fixed
    // for a given panel instance (a new figure gets a new mounted `TileDetailPanel`, not a param
    // change on an existing one).
  }, [open]);

  return (
    <div className={cx('disclosure-grid', open && 'open')}>
      <div className="mt-3 min-w-0 rounded-lg border border-border">
        {provenance && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 border-b border-border px-4 py-3 text-xs">
            {provenance.description && (
              <>
                <dt className="text-content-subtle">Definition</dt>
                <dd className="text-content">{provenance.description}</dd>
              </>
            )}
            <dt className="text-content-subtle">Period</dt>
            <dd className="text-content">
              {new Date(provenance.period.from).toLocaleDateString()} – {new Date(provenance.period.to).toLocaleDateString()}
              {' '}({provenance.storeTimezone})
            </dd>
            <dt className="text-content-subtle">Freshness</dt>
            <dd className="text-content">As of {new Date(provenance.freshness).toLocaleString()}</dd>
            <dt className="text-content-subtle">Sources</dt>
            <dd className="text-content">
              {provenance.sources.length > 0
                ? provenance.sources.map((s) => `${s.table} (${s.rowCount} row${s.rowCount === 1 ? '' : 's'})`).join(', ')
                : 'No contributing rows in this period.'}
            </dd>
          </dl>
        )}
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
                      value={row.amount ? formatMoneyTotal(row.amount.amount, row.amount.currency) : null}
                    />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </div>
  );
};

/**
 * A standalone "Show source rows" trigger for figures that live in a full-width `Card`, not a
 * narrow `StatTile` grid column (COGS variance, waste total) — those cards have room for a
 * regular button + panel, so they don't need `StatTile`'s click-the-whole-tile treatment.
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
  return (
    <div className="mt-2">
      <Button variant="ghost" className="px-2! py-1! text-xs" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide source rows' : 'Show source rows'}
      </Button>
      <TileDetailPanel open={open} provenance={null} storeId={storeId} figure={figure} from={from} to={to} {...(reasonCode ? { reasonCode } : {})} />
    </div>
  );
};

export default function DashboardPage() {
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [setupProgress, setSetupProgress] = useState<OnboardingProgress | null>(null);

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

  // The guided setup wizard used to be genuinely unreachable — nothing anywhere linked to it, so a
  // brand-new org landed on an empty dashboard with no route into setup. A nav entry now exists,
  // but a nav item alone is easy to miss on day one, which is exactly when it matters most. This
  // banner is deliberately driven by the REAL recorded progress row (never a guess at "looks
  // empty"), and disappears the moment every step is genuinely done or the user dismisses it.
  useEffect(() => {
    trpc.onboarding.getProgress.query().then(setSetupProgress).catch(() => setSetupProgress(null));
  }, []);

  const dismissSetup = async () => {
    // Optimistic: the banner is a prompt, not a figure — a failed dismiss that silently reappears
    // on the next load is a better outcome than blocking the user behind a spinner to hide a hint.
    setSetupProgress(null);
    await trpc.onboarding.dismiss.mutate().catch(() => undefined);
  };

  const setupIncomplete =
    setupProgress !== null &&
    !setupProgress.dismissed &&
    ONBOARDING_STEPS.some((step) => setupProgress[step] === 'PENDING');

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

      {setupIncomplete && (
        <Card className="mb-4 border-l-[3px] border-l-accent p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-content">Finish setting up</p>
              <p className="mt-0.5 text-sm text-content-muted">
                Connect your sales and upload invoices — that&apos;s what turns these figures from
                &ldquo;not known&rdquo; into real numbers.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link href="/onboarding">
                <Button variant="primary">Continue setup</Button>
              </Link>
              <Button variant="ghost" onClick={dismissSetup}>
                Dismiss
              </Button>
            </div>
          </div>
        </Card>
      )}

      {error && <ErrorNotice>{error}</ErrorNotice>}

      {/* First load has no prior summary to show, so it gets the real loading state. A REFETCH
          (period selector changed, a summary already on screen) instead keeps the old figures
          visible, dimmed, rather than blanking to a spinner — softens the transition between two
          real states without ever fabricating a value in between. */}
      {(loading || storesLoading) && !summary && <LoadingState />}
      {!storesLoading && stores.length === 0 && (
        <Card>
          <EmptyState
            title="No stores available."
            hint="Every workspace gets a store when it's created, so this usually means your account isn't linked to one yet. Contact your workspace owner if this doesn't resolve after signing out and back in."
          />
        </Card>
      )}

      {!error && summary && (
        <div className={cx('transition-opacity duration-150', loading ? 'opacity-50' : 'opacity-100')}>
          {/* The headline row: net revenue, contribution margin %, food cost %, stock value — each
              with delta + sparkline where a real trend exists. Edge-joined into one instrument panel
              rather than four detached cards. Each tile links to its own full-page detail
              (provenance + source rows) rather than expanding inline — a quarter-width grid column
              has no room to lay out a definition list or a 3-column table cleanly, which is what
              caused a real horizontal-overflow bug the first two times this was tried inline. */}
          <StatTileGrid className="mb-6">
            <StatTile
              label="Net revenue"
              value={fmt(summary.netRevenue)}
              hint={`${summary.transactionCount} transactions`}
              unknownReason="No priced sales were recorded in this period"
              {...trendProp(summary.trends.netRevenue)}
              delta={{ direction: summary.deltas.netRevenue.direction, label: `vs prior ${summary.period.days} days`, higherIsBetter: true }}
              {...(summary.netRevenue !== null && selectedStoreId
                ? { href: `/dashboard/metric/net_revenue?storeId=${selectedStoreId}&days=${days}` }
                : {})}
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
              {...(summary.contributionMarginPercentage !== null && selectedStoreId
                ? { href: `/dashboard/metric/contribution_margin?storeId=${selectedStoreId}&days=${days}` }
                : {})}
            />
            <StatTile
              label="Food cost"
              value={summary.foodCostPercentage !== null ? String(summary.foodCostPercentage) : null}
              unit="%"
              hint="COGS as a share of revenue"
              unknownReason={summary.unknownReasons.foodCostPercentage ?? 'Needs both COGS and revenue'}
              {...trendProp(summary.trends.foodCostPercentage)}
              delta={{ direction: summary.deltas.foodCostPercentage.direction, label: `vs prior ${summary.period.days} days`, higherIsBetter: false }}
              {...(summary.foodCostPercentage !== null && selectedStoreId
                ? { href: `/dashboard/metric/food_cost_percentage?storeId=${selectedStoreId}&days=${days}` }
                : {})}
            />
            <StatTile
              label="Stock value"
              value={fmt(summary.stockValue)}
              hint="Cash tied up in on-hand stock, right now"
              unknownReason="You need inventory:read to see this"
              {...(summary.stockValue !== null && selectedStoreId
                ? { href: `/dashboard/metric/stock_value?storeId=${selectedStoreId}&days=${days}` }
                : {})}
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
                <BarComparison
                  tone="positive"
                  rows={summary.itemsByContribution
                    .filter((item) => item.totalContribution !== null)
                    .slice(0, 5)
                    .map((item) => ({
                      key: item.menuItemId,
                      label: item.menuItemName,
                      value: Number(item.totalContribution!.amount),
                    }))}
                  formatValue={(value) => formatMoneyTotal(String(value), summary.currency)}
                />
              </Card>
              <Card>
                <CardHeader title="Bottom items by contribution" />
                <BarComparison
                  tone="danger"
                  rows={[...summary.itemsByContribution]
                    .reverse()
                    .filter((item) => item.totalContribution !== null)
                    .slice(0, 5)
                    .map((item) => ({
                      key: item.menuItemId,
                      label: item.menuItemName,
                      value: Number(item.totalContribution!.amount),
                    }))}
                  formatValue={(value) => formatMoneyTotal(String(value), summary.currency)}
                />
              </Card>
            </div>
          )}

          {/*
            The margin waterfall — spec §12.3's "why margin changed" view (price/cost/mix/volume
            effects, ADR-15's verified Q₁-weighted variant). `margin_attribution` was fully
            implemented and tested in packages/metrics but never wired to any route or UI until
            now — this panel and the router call above are that wiring, not a new formula.
          */}
          {summary.marginAttribution !== null && (
            <Card className="mb-6">
              <CardHeader title="Why margin changed" />
              {summary.marginAttribution.baseContributionMargin !== null &&
              summary.marginAttribution.priceEffect !== null &&
              summary.marginAttribution.costEffect !== null &&
              summary.marginAttribution.mixEffect !== null &&
              summary.marginAttribution.volumeEffect !== null ? (
                <MarginWaterfall
                  base={{ label: `${summary.period.days}d ago`, value: Number(summary.marginAttribution.baseContributionMargin.amount) }}
                  steps={[
                    { key: 'price', label: 'Price', value: Number(summary.marginAttribution.priceEffect.amount) },
                    { key: 'cost', label: 'Cost', value: Number(summary.marginAttribution.costEffect.amount) },
                    { key: 'mix', label: 'Mix', value: Number(summary.marginAttribution.mixEffect.amount) },
                    { key: 'volume', label: 'Volume', value: Number(summary.marginAttribution.volumeEffect.amount) },
                  ]}
                  formatValue={(value) => formatMoneyTotal(String(value), summary.currency)}
                />
              ) : (
                // I7: a waterfall's own math (running totals across bars) has no way to represent a
                // genuinely unknown component — substituting 0 for it would silently understate or
                // overstate every bar after it, not just look empty. Showing nothing, with the reason,
                // is the only honest option when any of the five figures is unknown.
                <p className="px-5 py-4 text-sm text-content-subtle">
                  Margin attribution is not fully known for this period — at least one price, cost,
                  mix, or volume effect could not be computed from items with a real, priced recipe
                  cost in both periods.
                </p>
              )}
            </Card>
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
                {(variance?.direction === 'over' || variance?.direction === 'under' || variance?.direction === 'exact') &&
                  summary.cogsActual &&
                  summary.cogsTheoretical && (
                    <DivergingBar
                      value={Number(summary.cogsActual.amount) - Number(summary.cogsTheoretical.amount)}
                      maxMagnitude={Math.max(Number(summary.cogsActual.amount), Number(summary.cogsTheoretical.amount))}
                      direction={variance.direction}
                    />
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
                <BarComparison
                  tone="warning"
                  rows={summary.waste.byReason.map((entry) => ({
                    key: entry.reasonCode,
                    label: humanize(entry.reasonCode),
                    value: Number(entry.value),
                  }))}
                  formatValue={(value) => formatMoneyTotal(String(value), summary.currency)}
                />
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
        </div>
      )}
    </>
  );
}
