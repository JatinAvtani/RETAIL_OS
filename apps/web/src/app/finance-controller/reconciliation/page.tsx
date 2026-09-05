'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import { formatMoneyTotal } from '@/lib/format';
import {
 Badge,
 Card,
 EmptyState,
 ErrorNotice,
 LoadingState,
 PageHeader,
 StatTile,
 StatTileGrid,
 Table,
 TableToolbar,
 Td,
 Th,
 Tr,
 Value,
} from '@/components/ui';

type BatchReport = Awaited<ReturnType<typeof trpc.reconciliation.batchReport.query>>;

/**
 * the direct answer to the Razorpay AI Buildathon "AI Finance Controller" track's
 * own literal brief — "closes one finance-ops loop across a 50+ record batch of synthetic data,
 * reporting its match rate and the exceptions it could not resolve." Every figure here comes
 * straight from `reconciliation.batchReport`, which itself only reads ALREADY-persisted
 * `invoice_match_lines` rows — this page adds no computation of its own, matching every
 * other numeric surface in this app.
 */
export default function ReconciliationReportPage() {
 const { selectedStoreId } = useStores();
 const [report, setReport] = useState<BatchReport | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [loading, setLoading] = useState(true);

 useEffect(() => {
 setLoading(true);
 setError(null);
 trpc.reconciliation.batchReport.query({...(selectedStoreId ? { storeId: selectedStoreId } : {}) }).then(setReport).catch(() => setError('Could not load the reconciliation report.')).finally(() => setLoading(false));
 }, [selectedStoreId]);

 const severityTone = (severity: string): 'danger' | 'warning' | 'neutral' =>
 severity === 'HIGH' ? 'danger' : severity === 'MEDIUM' ? 'warning' : 'neutral';

 return (
 <div>
 <PageHeader
 title="Batch Reconciliation"
 description="Every invoice line matched against its purchase order and goods receipt — a real, measured match rate and a ranked list of what could not be resolved automatically."
 actions={
 <Link href="/finance-controller" className="text-sm font-medium text-accent hover:underline">
 ← Finance Controller
 </Link>
 }
 />

 {error && <ErrorNotice>{error}</ErrorNotice>}
 {loading && <LoadingState label="Reconciling…" />}

 {report && !loading && (
 <>
 <StatTileGrid className="mb-6">
 <StatTile
 label="Lines reconciled"
 value={String(report.totalLines)}
 unknownReason="No invoice lines matched yet"
 />
 <StatTile
 label="Match rate"
 value={report.matchRate !== null ? `${(Number(report.matchRate) * 100).toFixed(1)}%` : null}
 unknownReason="No lines to compute a rate from"
 hint={`${report.cleanLines} of ${report.totalLines} clean`}
 />
 <StatTile
 label="Exceptions"
 value={String(report.exceptions.length)}
 unknownReason="No invoice lines matched yet"
 />
 <StatTile
 label="Total exception impact"
 value={report.totalExceptionImpact !== null ? formatMoneyTotal(report.totalExceptionImpact, report.currency) : null}
 unknownReason={report.unresolvableCount > 0 ? `${report.unresolvableCount} exception(s) have no computable dollar figure` : 'No exceptions'}
 {...(report.unresolvableCount > 0 ? { hint: `${report.unresolvableCount} unresolvable` } : {})}
 />
 </StatTileGrid>

 <Card>
 <TableToolbar>
 <span className="text-sm font-medium text-content">Exceptions, ranked by dollar impact</span>
 </TableToolbar>
 {report.exceptions.length === 0 ? (
 <EmptyState title="No exceptions" hint="Every reconciled line matched within tolerance." />) : (
 <Table aria-label="Reconciliation exceptions">
 <thead>
 <Tr>
 <Th>Supplier</Th>
 <Th>Product</Th>
 <Th>Type</Th>
 <Th>Severity</Th>
 <Th align="right">Impact</Th>
 </Tr>
 </thead>
 <tbody>
 {report.exceptions.map((exception) => (
 <Tr key={exception.lineId}>
 <Td>{exception.supplierName}</Td>
 <Td>{exception.productName ?? <span className="italic text-unknown">Unmatched</span>}</Td>
 <Td>{exception.varianceType.replace(/_/g, ' ').toLowerCase()}</Td>
 <Td>
 <Badge tone={severityTone(exception.varianceSeverity)}>{exception.varianceSeverity}</Badge>
 </Td>
 <Td align="right" variant="numeric">
 <Value
 value={
 exception.dollarImpact !== null
 ? formatMoneyTotal(exception.dollarImpact, report.currency)
 : null
 }
 />
 </Td>
 </Tr>))}
 </tbody>
 </Table>)}
 </Card>
 </>)}
 </div>);
}
