'use client';

import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import { useOrgCurrency } from '@/lib/use-org-currency';
import { Badge, Card, EmptyState, ErrorNotice, LoadingState, PageHeader, Select } from '@/components/ui';
import { formatMoney } from '@/lib/format';

/** Trims a real numeric string's trailing zeros for display only (e.g. real `1.000000` -> `1`) — never used for arithmetic, only how an already-correct number is shown. */
const trimTrailingZeros = (value: string): string => {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
};

type Report = Awaited<ReturnType<typeof trpc.firstFindingReport.generate.query>>;
type FindingType = Report['findings'][number];

/**
 * 012-10: "generated once enough invoices are processed... every claim cites its source
 * documents. This report is the product's proof." (plan.md). Every finding below is rendered
 * DIRECTLY from the real, already-computed values the router returns — no client-side arithmetic,
 * no narration, no LLM call. This is a deliberate v1 scope decision: a finding's own citation IS
 * the explanation, so nothing a model could add would be more trustworthy, and skipping the model
 * means this page works even when Gemini's daily quota is exhausted (a real, recurring constraint
 * this project has hit many times).
 */
export default function FirstFindingReportPage() {
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const currency = useOrgCurrency();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedStoreId) return;
    setLoading(true);
    setError(null);
    trpc.firstFindingReport.generate
      .query({ storeId: selectedStoreId, days: 90 })
      .then(setReport)
      .catch(() => setError('Could not generate the report.'))
      .finally(() => setLoading(false));
  }, [selectedStoreId]);

  return (
    <>
      <PageHeader
        title="Your first finding"
        description="Every claim below cites the real invoices it came from."
        actions={
          !storesLoading && stores.length > 0 ? (
            <Select value={selectedStoreId} onChange={(e) => setSelectedStoreId(e.target.value)} className="w-auto">
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </Select>
          ) : undefined
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      {(loading || storesLoading) && <LoadingState label="Analysing your invoices…" />}

      {!loading && !storesLoading && report && (
        <>
          <Card className="mb-6 p-5">
            <p className="text-sm text-content-muted">
              We analysed the last {report.periodDays} days of invoices from{' '}
              <span className="font-mono font-semibold text-content">{report.supplierCount}</span>{' '}
              supplier{report.supplierCount === 1 ? '' : 's'}.
            </p>
          </Card>

          {report.findings.length === 0 ? (
            <Card>
              <EmptyState
                title="No findings yet"
                hint="Approve more supplier invoices — price changes, duplicate charges, and cross-supplier price gaps all need real invoice history to surface."
              />
            </Card>
          ) : (
            <div className="space-y-3">
              {report.findings.map((finding, index) => (
                <FindingCard key={`${finding.kind}-${index}`} finding={finding} currency={currency} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

const FindingCard = ({ finding, currency }: { finding: FindingType; currency: string | null }) => {
  if (finding.kind === 'PRICE_CHANGE') {
    return (
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-content">
            <span className="font-semibold">{finding.productName}</span> from{' '}
            <span className="font-semibold">{finding.supplierName}</span> {finding.direction === 'up' ? 'rose' : 'fell'}{' '}
            <span className="font-mono font-semibold">{finding.percentChange}%</span>.
            {finding.annualizedImpact !== null && (
              <>
                {' '}
                Annualised impact <span className="font-mono font-semibold">~{formatMoney(finding.annualizedImpact, currency)}</span>.
              </>
            )}
          </p>
          <Badge tone="accent">{finding.evidenceDocumentIds.length} invoice{finding.evidenceDocumentIds.length === 1 ? '' : 's'}</Badge>
        </div>
      </Card>
    );
  }

  if (finding.kind === 'DUPLICATE_INVOICE') {
    return (
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-content">
            You were <span className="font-semibold">invoiced twice</span> by{' '}
            <span className="font-semibold">{finding.supplierName}</span>
            {finding.documentNumber ? ` — invoice #${finding.documentNumber}` : ''} —{' '}
            <span className="font-mono font-semibold">{formatMoney(finding.total, currency)}</span>.
          </p>
          <Badge tone="danger">{finding.evidenceDocumentIds.length} documents</Badge>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-content">
          <span className="font-semibold">{finding.productName}</span> costs{' '}
          <span className="font-mono font-semibold">{finding.percentDifference}%</span> more from{' '}
          <span className="font-semibold">{finding.pricierSupplierName}</span> than{' '}
          <span className="font-semibold">{finding.cheaperSupplierName}</span> for the same pack size (
          {trimTrailingZeros(finding.packSize)}
          {finding.packUnitCode}).
        </p>
        <Badge tone="accent">{finding.evidenceDocumentIds.length} invoices</Badge>
      </div>
    </Card>
  );
};
