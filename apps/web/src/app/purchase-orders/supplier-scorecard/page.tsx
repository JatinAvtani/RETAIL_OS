'use client';

import { useCallback, useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { humanizeEnum } from '@/lib/format';
import {
  BarComparison,
  Card,
  CardHeader,
  ErrorNotice,
  Field,
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

type Supplier = Awaited<ReturnType<typeof trpc.suppliers.list.query>>[number];
type Components = Awaited<ReturnType<typeof trpc.supplierPerformance.components.query>>;
type Events = Awaited<ReturnType<typeof trpc.supplierPerformance.events.query>>;
type Trend = Awaited<ReturnType<typeof trpc.supplierPerformance.trend.query>>;
type TrendDirection = 'up' | 'down' | 'flat' | null;

const pct = (value: number | null): string | null => (value === null ? null : (value * 100).toFixed(1));

/**
 * Direction alone doesn't say whether a change is good or bad (a rising fill rate is good, a rising
 * quality-reject rate is bad), so each call site below passes `higherIsBetter` for its specific
 * metric. The shared `TrendBadge` handles the tone mapping; this helper only supplies the basis
 * label every delta needs to be a fact rather than a bare arrow.
 */
const trendDelta = (direction: TrendDirection, higherIsBetter: boolean) => ({
  direction,
  label: direction === null ? 'No prior-period data' : 'vs. prior period',
  higherIsBetter,
});

/**
 * related work's scorecard: real components side by side, each drillable to the events that
 * produced it — never a single composite score (the design is explicit this is a fabricated-
 * scoring anti-pattern the product exists to avoid). `StatTile`'s own `null`-is-"Unknown" rule
 * (I7 at the UI layer) means a supplier with no measured history yet renders as honestly unknown,
 * never a guessed 0%/100%.
 */
export default function SupplierScorecardPage() {
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [days, setDays] = useState(90);
  const [components, setComponents] = useState<Components | null>(null);
  const [events, setEvents] = useState<Events | null>(null);
  const [trend, setTrend] = useState<Trend | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    trpc.suppliers.list.query().then((list) => {
      setSuppliers(list);
      if (list.length > 0) setSupplierId((current) => current || list[0]!.id);
    });
  }, []);

  const load = useCallback(() => {
    if (!supplierId) return;
    setLoading(true);
    setError(null);
    Promise.all([
      trpc.supplierPerformance.components.query({ supplierId, days }),
      trpc.supplierPerformance.events.query({ supplierId, days }),
      trpc.supplierPerformance.trend.query({ supplierId, days }),
    ])
      .then(([componentsResult, eventsResult, trendResult]) => {
        setComponents(componentsResult);
        setEvents(eventsResult);
        setTrend(trendResult);
      })
      .catch(() => setError('Could not load this supplier’s performance data.'))
      .finally(() => setLoading(false));
  }, [supplierId, days]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <PageHeader
        title="Supplier scorecard"
        description="Click any number to see the real deliveries behind it."
      />

      <Card className="mb-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Supplier">
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} disabled={!suppliers}>
              {!suppliers && <option>Loading…</option>}
              {suppliers?.length === 0 && <option>No suppliers yet</option>}
              {suppliers?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Window" hint="How far back to look for real events">
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 180 days</option>
              <option value={365}>Last 365 days</option>
            </Select>
          </Field>
        </div>
      </Card>

      {error && <ErrorNotice>{error}</ErrorNotice>}

      {loading && (
        <Card>
          <LoadingState />
        </Card>
      )}

      {!loading && components && (
        <>
          {/* Five components side by side, never a single composite score — a rolled-up supplier
              "grade" is the fabricated-scoring anti-pattern this product exists to avoid. */}
          <StatTileGrid className="mb-6 lg:grid-cols-5">
            <StatTile
              label="Fill rate"
              value={pct(components.fillRate)}
              unit="%"
              hint="Received vs. ordered quantity"
              unknownReason="No deliveries recorded against a purchase order in this window"
              {...(trend ? { delta: trendDelta(trend.fillRate.direction, true) } : {})}
            />
            <StatTile
              label="On-time rate"
              value={pct(components.onTimeRate)}
              unit="%"
              hint="Deliveries by the PO's expected date"
              unknownReason="No PO carried an expected delivery date in this window"
              {...(trend ? { delta: trendDelta(trend.onTimeRate.direction, true) } : {})}
            />
            <StatTile
              label="Price variance"
              value={components.totalPriceVariance}
              hint="Sum of real per-unit price drift vs. the PO price"
              unknownReason="No matched invoice line had a real price variance in this window"
              {...(trend ? { delta: trendDelta(trend.totalPriceVariance.direction, false) } : {})}
            />
            <StatTile
              label="Invoice accuracy"
              value={pct(components.invoiceAccuracy)}
              unit="%"
              hint="Clean invoices ÷ total matched invoices"
              unknownReason="No invoice was matched in this window"
              {...(trend ? { delta: trendDelta(trend.invoiceAccuracy.direction, true) } : {})}
            />
            <StatTile
              label="Quality reject rate"
              value={pct(components.qualityRejectRate)}
              unit="%"
              hint="Rejected quantity ÷ received quantity"
              unknownReason="No receiving activity in this window"
              {...(trend ? { delta: trendDelta(trend.qualityRejectRate.direction, false) } : {})}
            />
          </StatTileGrid>

          {!events || events.length === 0 ? (
            <Card>
              <p className="p-4 text-sm text-content-subtle">No real events in this window — every figure above is honestly unknown, not a fabricated zero.</p>
            </Card>
          ) : (
            <>
              {(() => {
                // Price changes carry a real, comparable dollar variance per event — the one event
                // type in this ledger where "how much did this move, and in which events" is
                // honestly chartable without mixing units. Fill/on-time events are pass/fail, not a
                // magnitude, so they stay in the raw table below rather than being forced into a bar.
                const priceChanges = events
                  .filter((e) => e.eventType === 'PRICE_CHANGE' && e.variance !== null)
                  .map((e) => ({
                    key: e.id,
                    label: new Date(e.occurredAt).toLocaleDateString(),
                    value: Number(e.variance),
                  }));
                if (priceChanges.length === 0) return null;
                return (
                  <Card className="mb-6">
                    <CardHeader title="Price change variance" />
                    <BarComparison
                      tone="warning"
                      rows={priceChanges}
                      formatValue={(value) => value.toFixed(2)}
                    />
                  </Card>
                );
              })()}
              <Card>
                <Table>
                  <thead>
                    <tr>
                      <Th>Occurred</Th>
                      <Th>Event</Th>
                      <Th align="right">Expected</Th>
                      <Th align="right">Actual</Th>
                      <Th align="right">Variance</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e) => (
                      <Tr key={e.id}>
                        <Td className="font-mono text-content-muted">
                          {new Date(e.occurredAt).toLocaleDateString()}
                        </Td>
                        <Td>{humanizeEnum(e.eventType)}</Td>
                        {/* Variance figures, so a dash would read as "no drift" — the one reading
                            that is definitely wrong when the value is simply absent. */}
                        <Td variant="numeric">
                          <Value value={e.expectedValue} />
                        </Td>
                        <Td variant="numeric">
                          <Value value={e.actualValue} />
                        </Td>
                        <Td variant="numeric">
                          <Value value={e.variance} />
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            </>
          )}
        </>
      )}
    </>
  );
}
