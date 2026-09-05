'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { formatMoneyTotal } from '@/lib/format';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  LoadingState,
  PageHeader,
  Table,
  Td,
  Th,
  Tr,
  Value,
} from '@/components/ui';

type Summary = Awaited<ReturnType<typeof trpc.dashboard.summary.query>>;
type DrillThroughResult = Awaited<ReturnType<typeof trpc.dashboard.drillThrough.query>>;
type DrillThroughFigure = Parameters<typeof trpc.dashboard.drillThrough.query>[0]['figure'];

/** The label + which `summary.provenance` key backs each figure this page can show — the same closed set `dashboard.drillThrough` accepts, so an unknown `figure` in the URL is caught rather than silently querying with a bad enum value. */
const FIGURE_META: Record<string, { label: string; provenanceKey: keyof Summary['provenance'] }> = {
  net_revenue: { label: 'Net revenue', provenanceKey: 'netRevenue' },
  contribution_margin: { label: 'Contribution margin', provenanceKey: 'contributionMargin' },
  food_cost_percentage: { label: 'Food cost %', provenanceKey: 'foodCostPercentage' },
  stock_value: { label: 'Stock value', provenanceKey: 'stockValue' },
};

/**
 * A real page instead of an inline expansion, per the user's own call after seeing the tile
 * disclosure still looked cramped even after the overflow fix: a `StatTile` is a quarter-width
 * grid column, and neither a provenance `<dl>` nor a 3-column source-rows table has room to lay
 * out cleanly at that width no matter how the CSS is tuned. This route gets the full page width
 * instead. Deliberately a sibling of `/dashboard`, not a child with its own `layout.tsx` — it
 * inherits `AuthGuard` from `dashboard/layout.tsx` for free, matching this codebase's own standing
 * rule against the double-AppShell trap a nested layout would cause.
 */
export default function MetricDetailPage() {
  const params = useParams<{ figure: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();

  const storeId = searchParams.get('storeId');
  const days = Number(searchParams.get('days') ?? '30');
  const meta = FIGURE_META[params.figure];

  const [summary, setSummary] = useState<Summary | null>(null);
  const [result, setResult] = useState<DrillThroughResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId || !meta) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    Promise.all([
      trpc.dashboard.summary.query({ storeId, days }),
      trpc.dashboard.drillThrough.query({
        storeId,
        figure: params.figure as DrillThroughFigure,
        from: from.toISOString(),
        to: to.toISOString(),
      }),
    ])
      .then(([summaryResult, drillThroughResult]) => {
        setSummary(summaryResult);
        setResult(drillThroughResult);
      })
      .catch(() => setError('Could not load this figure.'))
      .finally(() => setLoading(false));
  }, [storeId, days, params.figure, meta]);

  if (!meta) {
    return (
      <>
        <PageHeader title="Figure not found" />
        <ErrorNotice>This isn&apos;t a figure with a detail view.</ErrorNotice>
      </>
    );
  }

  const provenance = summary?.provenance[meta.provenanceKey] ?? null;

  return (
    <>
      <PageHeader
        title={meta.label}
        description="Where this figure came from — its definition, period, and every row that fed it."
        actions={
          <Button variant="ghost" onClick={() => router.back()}>
            Back to overview
          </Button>
        }
      />

      {loading && <LoadingState />}
      {!loading && error && <ErrorNotice>{error}</ErrorNotice>}
      {!loading && !error && !storeId && <ErrorNotice>No store selected.</ErrorNotice>}

      {!loading && !error && storeId && (
        <>
          {provenance && (
            <Card className="mb-6">
              <CardHeader title="How this is calculated" />
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-5 py-4 text-sm">
                {provenance.description && (
                  <>
                    <dt className="text-content-subtle">Definition</dt>
                    <dd className="text-content">{provenance.description}</dd>
                  </>
                )}
                <dt className="text-content-subtle">Period</dt>
                <dd className="text-content">
                  {new Date(provenance.period.from).toLocaleDateString()} –{' '}
                  {new Date(provenance.period.to).toLocaleDateString()} ({provenance.storeTimezone})
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
            </Card>
          )}

          <Card>
            <CardHeader title="Source rows" />
            {result && result.rows.length === 0 && result.relatedFigures && (
              <EmptyState
                title="No rows directly behind this figure"
                hint={`This figure combines ${result.relatedFigures.join(' and ')} — open those figures to see the real rows.`}
              />
            )}
            {result && result.rows.length === 0 && !result.relatedFigures && (
              <EmptyState title="No source rows" hint="Nothing contributed to this figure in the selected period." />
            )}
            {result && result.rows.length > 0 && (
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
          </Card>
        </>
      )}
    </>
  );
}
