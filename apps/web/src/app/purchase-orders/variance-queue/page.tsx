'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { Badge, Card, EmptyState, ErrorNotice, LoadingState, PageHeader, Table, Td, Th, Tr, type BadgeTone } from '@/components/ui';

type PendingResult = Awaited<ReturnType<typeof trpc.invoiceMatches.pending.query>>;
type Match = PendingResult[number];

const severityTone = (severity: string | null): BadgeTone => {
  if (severity === 'HIGH') return 'danger';
  if (severity === 'MEDIUM') return 'warning';
  if (severity === 'LOW') return 'accent';
  return 'neutral';
};

/**
 * 008-12: the manager's real review queue — every `PENDING` three-way match with an actual
 * variance, worst severity first. A CLEAN match never appears here at all (filtered server-side in
 * `InvoiceMatchRepository.findPending`, confirmed with the user) — a queue full of clean invoices
 * would be exactly the alert fatigue 008-11's configurable tolerances exist to prevent.
 */
export default function VarianceQueuePage() {
  const [data, setData] = useState<PendingResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    trpc.invoiceMatches.pending
      .query({})
      .then(setData)
      .catch(() => setError('Could not load the variance review queue.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <>
        <PageHeader title="Variance review queue" />
        <Card>
          <LoadingState />
        </Card>
      </>
    );
  }

  if (error && !data) {
    return (
      <>
        <PageHeader title="Variance review queue" />
        <ErrorNotice>{error}</ErrorNotice>
      </>
    );
  }

  if (!data) return null;

  return (
    <>
      <PageHeader title="Variance review queue" description="Three-way match results outside tolerance, worst severity first." />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <Card>
        {data.length === 0 ? (
          <EmptyState title="Nothing to review" hint="Every recent invoice matched cleanly within tolerance." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Matched</Th>
                <Th>Purchase order</Th>
                <Th>Severity</Th>
                <Th align="right">Action</Th>
              </tr>
            </thead>
            <tbody>
              {data.map((match: Match) => (
                <Tr key={match.id}>
                  <Td>{new Date(match.matchedAt).toLocaleString()}</Td>
                  <Td>
                    {match.purchaseOrderId ? (
                      <Link href={`/purchase-orders/${match.purchaseOrderId}`} className="text-accent hover:underline">
                        View PO
                      </Link>
                    ) : (
                      <span className="text-content-subtle">No purchase order matched</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={severityTone(match.highestSeverity)}>{match.highestSeverity ?? 'UNKNOWN'}</Badge>
                  </Td>
                  <Td align="right">
                    <Link href={`/invoice-matches/${match.id}`} className="text-accent hover:underline">
                      Review
                    </Link>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
