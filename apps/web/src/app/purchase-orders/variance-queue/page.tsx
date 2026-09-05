'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { humanizeEnum, formatMoneyTotal, formatAge } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  TableToolbar,
  Td,
  Th,
  Tr,
  type BadgeTone,
} from '@/components/ui';

type PendingResult = Awaited<ReturnType<typeof trpc.invoiceMatches.pending.query>>;
type Match = PendingResult[number];

const severityTone = (severity: string | null): BadgeTone => {
  if (severity === 'HIGH') return 'danger';
  if (severity === 'MEDIUM') return 'warning';
  if (severity === 'LOW') return 'accent';
  return 'neutral';
};

const SEVERITY_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const PAGE_SIZE = 20;

type SortKey = 'impact' | 'severity' | 'age';

/**
 * the manager's real review queue — every `PENDING` three-way match with an actual
 * variance, worst severity first. A CLEAN match never appears here at all (filtered server-side in
 * `InvoiceMatchRepository.findPending`, confirmed with the user) — a queue full of clean invoices
 * would be exactly the alert fatigue earlier work's configurable tolerances exist to prevent.
 *
 * Filters/sort/pagination are client-side, deliberately — the whole queue is by definition bounded
 * to CURRENTLY pending reviews (items leave the moment they're resolved), not an ever-growing
 * historical table; 73 rows in the real dev dataset confirms this is the right scale for a single
 * fetch, not a case needing this codebase's own keyset-pagination convention.
 */
export default function VarianceQueuePage() {
  const [data, setData] = useState<PendingResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<string>('ALL');
  const [sortKey, setSortKey] = useState<SortKey>('severity');
  const [page, setPage] = useState(0);

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

  // Filtering/sorting reset the page back to the first — a filter narrowing 73 rows to 4 leaving
  // the reader stranded on page 3 of an now-empty list is a real, easy-to-hit usability bug.
  useEffect(() => {
    setPage(0);
  }, [severityFilter, sortKey]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const rows = severityFilter === 'ALL' ? data : data.filter((m) => m.highestSeverity === severityFilter);
    // A defensive copy — sorting the array tRPC/React Query handed back in place would mutate
    // cached query state.
    return [...rows].sort((a, b) => {
      if (sortKey === 'impact') {
        const aImpact = a.dollarImpact !== null ? Math.abs(Number(a.dollarImpact)) : -1;
        const bImpact = b.dollarImpact !== null ? Math.abs(Number(b.dollarImpact)) : -1;
        return bImpact - aImpact;
      }
      if (sortKey === 'age') {
        return new Date(a.matchedAt).getTime() - new Date(b.matchedAt).getTime();
      }
      // severity — the server's own default ordering (worst-first, then most-recent), preserved
      // as this sort option's tie-breaker rather than re-deriving a second severity rank.
      const aRank = SEVERITY_ORDER[a.highestSeverity ?? ''] ?? 3;
      const bRank = SEVERITY_ORDER[b.highestSeverity ?? ''] ?? 3;
      return aRank - bRank;
    });
  }, [data, severityFilter, sortKey]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (loading) {
    return (
      <>
        <PageHeader title="Variance review queue" />
        <Card>
          <SkeletonRows columns={7} />
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
      <PageHeader title="Variance review queue" description="Mismatches worth checking, worst first." />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <Card>
        {data.length === 0 ? (
          <EmptyState title="Nothing to review" hint="Every recent invoice matched cleanly within tolerance." />
        ) : (
          <>
            <TableToolbar>
              <Select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)} className="w-40">
                <option value="ALL">All severities</option>
                <option value="HIGH">High</option>
                <option value="MEDIUM">Medium</option>
                <option value="LOW">Low</option>
              </Select>
              <Select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className="w-56">
                <option value="severity">Sort: severity (default)</option>
                <option value="impact">Sort: financial impact</option>
                <option value="age">Sort: oldest first</option>
              </Select>
              <span className="ml-auto text-xs text-content-subtle">
                {filtered.length} {filtered.length === 1 ? 'match' : 'matches'}
              </span>
            </TableToolbar>

            {pageRows.length === 0 ? (
              <EmptyState title="No matches at this severity" hint="Try a different filter." />
            ) : (
              <Table aria-label="Invoice variance review queue">
                <thead>
                  <tr>
                    <Th>Supplier</Th>
                    <Th>Matched</Th>
                    <Th>Age</Th>
                    <Th>Purchase order</Th>
                    <Th>Severity</Th>
                    <Th align="right">Est. impact</Th>
                    <Th align="right">Action</Th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((match: Match) => (
                    <Tr key={match.id}>
                      <Td>{match.supplierName}</Td>
                      <Td>{new Date(match.matchedAt).toLocaleString()}</Td>
                      <Td>{formatAge(match.matchedAt)}</Td>
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
                        <Badge tone={severityTone(match.highestSeverity)}>
                          {match.highestSeverity ? humanizeEnum(match.highestSeverity) : 'Unknown'}
                        </Badge>
                      </Td>
                      <Td align="right" className="font-mono">
                        {match.dollarImpact !== null ? (
                          formatMoneyTotal(match.dollarImpact)
                        ) : (
                          <span className="text-content-subtle">Unknown</span>
                        )}
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

            {pageCount > 1 && (
              <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-sm">
                <span className="text-content-subtle">
                  Page {page + 1} of {pageCount}
                </span>
                <div className="flex gap-2">
                  <Button type="button" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                    Previous
                  </Button>
                  <Button type="button" variant="secondary" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
