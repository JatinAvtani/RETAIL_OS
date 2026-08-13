'use client';

import { useCallback, useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import {
  Badge,
  Card,
  ErrorNotice,
  Field,
  LoadingState,
  PageHeader,
  Select,
  StatTile,
  Table,
  Td,
  Th,
  Tr,
  type BadgeTone,
} from '@/components/ui';

type Supplier = Awaited<ReturnType<typeof trpc.suppliers.list.query>>[number];
type Components = Awaited<ReturnType<typeof trpc.supplierPerformance.components.query>>;
type Events = Awaited<ReturnType<typeof trpc.supplierPerformance.events.query>>;
type Trend = Awaited<ReturnType<typeof trpc.supplierPerformance.trend.query>>;
type TrendDirection = 'up' | 'down' | 'flat' | null;

const pct = (value: number | null): string | null => (value === null ? null : (value * 100).toFixed(1));

/**
 * 008-15: a real up/down/flat badge next to each component — spec's own "components side by side
 * WITH TRENDS." Direction alone doesn't say whether a change is good or bad (a rising fill rate is
 * good, a rising quality-reject rate is bad), so each call site tells this component which
 * direction means "positive" for that specific metric — `higherIsBetter` flips the tone mapping,
 * never the direction itself (the direction stays a plain factual up/down/flat regardless).
 */
const TrendBadge = ({ direction, higherIsBetter }: { direction: TrendDirection; higherIsBetter: boolean }) => {
  if (direction === null) return <span className="text-xs text-content-subtle">No prior-period data</span>;
  const isGood = direction === 'flat' ? null : (direction === 'up') === higherIsBetter;
  const tone: BadgeTone = isGood === null ? 'neutral' : isGood ? 'positive' : 'danger';
  const arrow = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→';
  const label = direction === 'up' ? 'Up' : direction === 'down' ? 'Down' : 'Flat';
  return (
    <Badge tone={tone}>
      {arrow} {label} vs. prior period
    </Badge>
  );
};

/**
 * 008-13/008-15's scorecard: real components side by side, each drillable to the events that
 * produced it — never a single composite score (spec 05 §5.3.3 is explicit this is a fabricated-
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
        description="Measured components only, each drillable to the real events behind it — no composite score."
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
          <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <StatTile
                label="Fill rate"
                value={pct(components.fillRate)}
                unit="%"
                hint="Received vs. ordered quantity"
                unknownReason="No deliveries recorded against a purchase order in this window"
              />
              {trend && <div className="mt-2"><TrendBadge direction={trend.fillRate.direction} higherIsBetter={true} /></div>}
            </div>
            <div>
              <StatTile
                label="On-time rate"
                value={pct(components.onTimeRate)}
                unit="%"
                hint="Deliveries by the PO's expected date"
                unknownReason="No PO carried an expected delivery date in this window"
              />
              {trend && <div className="mt-2"><TrendBadge direction={trend.onTimeRate.direction} higherIsBetter={true} /></div>}
            </div>
            <div>
              <StatTile
                label="Price variance"
                value={components.totalPriceVariance}
                hint="Sum of real per-unit price drift vs. the PO price"
                unknownReason="No matched invoice line had a real price variance in this window"
              />
              {trend && <div className="mt-2"><TrendBadge direction={trend.totalPriceVariance.direction} higherIsBetter={false} /></div>}
            </div>
            <div>
              <StatTile
                label="Invoice accuracy"
                value={pct(components.invoiceAccuracy)}
                unit="%"
                hint="Clean invoices ÷ total matched invoices"
                unknownReason="No invoice was matched in this window"
              />
              {trend && <div className="mt-2"><TrendBadge direction={trend.invoiceAccuracy.direction} higherIsBetter={true} /></div>}
            </div>
            <div>
              <StatTile
                label="Quality reject rate"
                value={pct(components.qualityRejectRate)}
                unit="%"
                hint="Rejected quantity ÷ received quantity"
                unknownReason="No receiving activity in this window"
              />
              {trend && <div className="mt-2"><TrendBadge direction={trend.qualityRejectRate.direction} higherIsBetter={false} /></div>}
            </div>
          </div>

          <Card>
            {!events || events.length === 0 ? (
              <p className="p-4 text-sm text-content-subtle">No real events in this window — every figure above is honestly unknown, not a fabricated zero.</p>
            ) : (
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
                      <Td>{new Date(e.occurredAt).toLocaleDateString()}</Td>
                      <Td>{e.eventType}</Td>
                      <Td align="right">{e.expectedValue ?? '—'}</Td>
                      <Td align="right">{e.actualValue ?? '—'}</Td>
                      <Td align="right">{e.variance ?? '—'}</Td>
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
