'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { Badge, Button, Card, ErrorNotice, Field, Input, LoadingState, PageHeader, Table, Td, Th, Tr, Value, type BadgeTone } from '@/components/ui';

type GetResult = Awaited<ReturnType<typeof trpc.invoiceMatches.get.query>>;
type Line = GetResult['lines'][number];

const severityTone = (severity: string): BadgeTone => {
  if (severity === 'HIGH') return 'danger';
  if (severity === 'MEDIUM') return 'warning';
  if (severity === 'LOW') return 'accent';
  return 'positive';
};

const VARIANCE_LABELS: Record<string, string> = {
  CLEAN: 'Clean',
  PRICE_VARIANCE: 'Price variance',
  QUANTITY_VARIANCE: 'Quantity variance',
  UNORDERED_ITEM: 'Unordered item',
  INVOICED_NOT_RECEIVED: 'Invoiced, not received',
};

/**
 * 008-10 (plan.md Phase 4, spec 05 §5.2.4): "the financial control that catches real money" —
 * this is the screen a manager actually reads to see it. Runs automatically after
 * `documents.approve` for an INVOICE-type document (no manual "run match" button here — matching
 * `PostingService`'s own confirmed-with-the-user precedent of running inline, not as a separate
 * step a user has to remember to trigger).
 */
export default function InvoiceMatchDetailPage() {
  const params = useParams<{ invoiceMatchId: string }>();
  const [data, setData] = useState<GetResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [resolving, setResolving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    trpc.invoiceMatches.get
      .query({ invoiceMatchId: params.invoiceMatchId })
      .then(setData)
      .catch(() => setError('Could not load this invoice match.'))
      .finally(() => setLoading(false));
  }, [params.invoiceMatchId]);

  useEffect(() => {
    load();
  }, [load]);

  const resolve = async () => {
    setResolving(true);
    setError(null);
    try {
      await trpc.invoiceMatches.resolve.mutate({ invoiceMatchId: params.invoiceMatchId, resolutionNotes });
      setResolutionNotes('');
      load();
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Could not resolve this variance.';
      setError(message);
    } finally {
      setResolving(false);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title="Invoice match" />
        <Card>
          <LoadingState />
        </Card>
      </>
    );
  }

  if (error && !data) {
    return (
      <>
        <PageHeader title="Invoice match" />
        <ErrorNotice>{error}</ErrorNotice>
      </>
    );
  }

  if (!data) return null;

  const { invoiceMatch, lines } = data;
  const varianceLines = lines.filter((line: Line) => line.varianceType !== 'CLEAN');

  return (
    <>
      <PageHeader
        title="Three-way match"
        description={`Matched ${new Date(invoiceMatch.matchedAt).toLocaleString()}`}
        actions={<Badge tone={severityTone(invoiceMatch.highestSeverity ?? 'NONE')}>{invoiceMatch.highestSeverity ?? 'NONE'}</Badge>}
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <Card className="mb-6 p-6">
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-content-subtle">Purchase order</dt>
            <dd className="mt-1 text-sm text-content">
              {invoiceMatch.purchaseOrderId ? (
                <Link href={`/purchase-orders/${invoiceMatch.purchaseOrderId}`} className="text-accent hover:underline">
                  View purchase order
                </Link>
              ) : (
                <span className="text-content-subtle">No purchase order matched</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-content-subtle">Lines with variance</dt>
            <dd className="mt-1 text-sm text-content">
              {varianceLines.length} of {lines.length}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-content-subtle">Status</dt>
            <dd className="mt-1 text-sm text-content">{invoiceMatch.status}</dd>
          </div>
        </dl>
      </Card>

      {invoiceMatch.highestSeverity !== 'NONE' && invoiceMatch.highestSeverity !== null && (
        <Card className="mb-6 p-6">
          {invoiceMatch.status === 'RESOLVED' ? (
            <>
              <h3 className="mb-2 text-sm font-semibold text-content">Resolved</h3>
              <p className="text-sm text-content-muted">{invoiceMatch.resolutionNotes}</p>
              {invoiceMatch.resolvedAt && (
                <p className="mt-1 text-xs text-content-subtle">{new Date(invoiceMatch.resolvedAt).toLocaleString()}</p>
              )}
            </>
          ) : (
            <>
              <h3 className="mb-1 text-sm font-semibold text-content">Resolve this variance</h3>
              <p className="mb-3 text-sm text-content-subtle">
                Explain how this discrepancy was handled — required, so the resolution stays auditable.
              </p>
              <Field label="Resolution note">
                <Input
                  value={resolutionNotes}
                  onChange={(e) => setResolutionNotes(e.target.value)}
                  placeholder="e.g. Confirmed with supplier — credit issued for the shortfall."
                />
              </Field>
              <div className="mt-3">
                <Button type="button" variant="primary" disabled={resolving || resolutionNotes.trim().length === 0} onClick={resolve}>
                  Mark resolved
                </Button>
              </div>
            </>
          )}
        </Card>
      )}

      <Card>
        {lines.length === 0 ? (
          <p className="p-6 text-sm text-content-subtle">No lines on this invoice.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Line</Th>
                <Th>SKU</Th>
                <Th align="right">Invoiced qty</Th>
                <Th align="right">Received qty</Th>
                <Th align="right">Invoiced price</Th>
                <Th align="right">PO price</Th>
                <Th>Variance</Th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line: Line) => (
                <Tr key={line.id}>
                  <Td>{Number(line.invoiceLineIndex) + 1}</Td>
                  <Td>
                    <Value value={line.invoiceSku} />
                  </Td>
                  <Td align="right" className="tabular">
                    <Value value={line.invoiceQuantity} />
                  </Td>
                  <Td align="right" className="tabular">
                    <Value value={line.receivedQuantity} />
                  </Td>
                  <Td align="right" className="tabular">
                    <Value value={line.invoiceUnitPrice} />
                  </Td>
                  <Td align="right" className="tabular">
                    <Value value={line.poUnitPrice} />
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <Badge tone={severityTone(line.varianceSeverity)}>{VARIANCE_LABELS[line.varianceType] ?? line.varianceType}</Badge>
                      {line.varianceType !== 'CLEAN' && <span className="text-xs text-content-subtle">{line.explanation}</span>}
                    </div>
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
