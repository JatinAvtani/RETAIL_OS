'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { Badge, Button, Card, ErrorNotice, LoadingState, PageHeader, Table, Td, Th, Tr, Value, type BadgeTone } from '@/components/ui';

type GetResult = Awaited<ReturnType<typeof trpc.purchaseOrders.get.query>>;
type Status = GetResult['purchaseOrder']['status'];

/**
 * No `'REJECTED'` status exists — `REJECT` (spec 05 §5.2.2's own diagram) returns a PO to `DRAFT`,
 * not a new terminal state, matching `packages/domain`'s `applyPurchaseOrderTransition` exactly.
 * A rejection is only visible via `rejectedAt`/`rejectionReason` staying set on an otherwise-DRAFT
 * row, not a distinct status value.
 */
const statusTone = (status: Status): BadgeTone => {
  if (status === 'RECEIVED' || status === 'CLOSED') return 'positive';
  if (status === 'CANCELLED') return 'danger';
  if (status === 'PENDING_APPROVAL') return 'warning';
  if (status === 'APPROVED' || status === 'SENT' || status === 'PARTIALLY_RECEIVED') return 'accent';
  return 'neutral';
};

/**
 * 008-05: the real HTTP surface for `purchase_orders`' state machine (008-01). Every action button
 * shown is only the ones actually legal from the CURRENT status — mirroring
 * `applyPurchaseOrderTransition`'s own domain rules on the client, so a manager never sees a button
 * that would just come back rejected. The server's own state-machine check (packages/domain) is
 * still the real authority; this is a UX convenience, not a security boundary.
 */
export default function PurchaseOrderDetailPage() {
  const params = useParams<{ purchaseOrderId: string }>();
  const [data, setData] = useState<GetResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [pdfUrlPending, setPdfUrlPending] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    trpc.purchaseOrders.get
      .query({ purchaseOrderId: params.purchaseOrderId })
      .then(setData)
      .catch(() => setError('Could not load this purchase order.'))
      .finally(() => setLoading(false));
  }, [params.purchaseOrderId]);

  useEffect(() => {
    load();
  }, [load]);

  const runAction = async (action: () => Promise<unknown>) => {
    setActionPending(true);
    setError(null);
    try {
      await action();
      await load();
      setShowRejectForm(false);
      setRejectReason('');
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'That action could not be completed.';
      setError(message);
    } finally {
      setActionPending(false);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title="Purchase order" />
        <Card>
          <LoadingState />
        </Card>
      </>
    );
  }

  if (error && !data) {
    return (
      <>
        <PageHeader title="Purchase order" />
        <ErrorNotice>{error}</ErrorNotice>
      </>
    );
  }

  if (!data) return null;

  const { purchaseOrder, lines, total } = data;
  const version = purchaseOrder.version;

  const downloadPdf = async () => {
    setPdfUrlPending(true);
    setError(null);
    try {
      const result = await trpc.purchaseOrders.getPdfUrl.query({ purchaseOrderId: purchaseOrder.id });
      if (result.url === null) {
        setError('This purchase order has not been sent yet — no PDF exists.');
        return;
      }
      window.open(result.url, '_blank', 'noopener,noreferrer');
    } catch {
      setError('Could not fetch the purchase order PDF.');
    } finally {
      setPdfUrlPending(false);
    }
  };

  return (
    <>
      <PageHeader
        title={purchaseOrder.poNumber}
        description={`Created ${new Date(purchaseOrder.createdAt).toLocaleDateString()}`}
        actions={<Badge tone={statusTone(purchaseOrder.status)}>{purchaseOrder.status.replace(/_/g, ' ')}</Badge>}
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <Card className="mb-6 p-6">
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-content-subtle">Total</dt>
            <dd className="mt-1 text-lg font-semibold text-content">
              <Value value={total} unit={purchaseOrder.currency} />
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-content-subtle">Currency</dt>
            <dd className="mt-1 text-sm text-content">{purchaseOrder.currency}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-content-subtle">Version</dt>
            <dd className="mt-1 text-sm text-content">{version}</dd>
          </div>
        </dl>
      </Card>

      <Card className="mb-6">
        {lines.length === 0 ? (
          <p className="p-6 text-sm text-content-subtle">No lines yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Line</Th>
                <Th align="right">Quantity (order units)</Th>
                <Th align="right">Quantity (base units)</Th>
                <Th align="right">Unit price</Th>
                <Th align="right">Line total</Th>
                <Th align="right">Received</Th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <Tr key={line.id}>
                  <Td>{line.lineNumber}</Td>
                  <Td align="right" className="tabular">
                    {line.quantityOrderUnits}
                  </Td>
                  <Td align="right" className="tabular">
                    {line.quantityBaseUnits}
                  </Td>
                  <Td align="right" className="tabular">
                    {line.unitPrice}
                  </Td>
                  <Td align="right" className="tabular">
                    {line.lineTotal}
                  </Td>
                  <Td align="right" className="tabular">
                    <Value value={line.receivedQuantityBaseUnits} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {(purchaseOrder.pdfObjectKey !== null || purchaseOrder.emailSentAt !== null) && (
        <Card className="mb-6 p-6">
          <h3 className="mb-4 text-sm font-semibold text-content">Supplier document</h3>
          <div className="flex flex-wrap items-center gap-4">
            {purchaseOrder.pdfObjectKey !== null && (
              <Button type="button" variant="ghost" disabled={pdfUrlPending} onClick={downloadPdf}>
                Download PDF
              </Button>
            )}
            {purchaseOrder.emailSentAt !== null && (
              <p className="text-sm text-content-subtle">
                Emailed to {purchaseOrder.emailSentTo} on {new Date(purchaseOrder.emailSentAt).toLocaleString()}
              </p>
            )}
          </div>
        </Card>
      )}

      <Card className="p-6">
        <h3 className="mb-4 text-sm font-semibold text-content">Actions</h3>
        <div className="flex flex-wrap items-center gap-2">
          {purchaseOrder.status === 'DRAFT' && (
            <Button
              type="button"
              variant="primary"
              disabled={actionPending}
              onClick={() => runAction(() => trpc.purchaseOrders.submit.mutate({ purchaseOrderId: purchaseOrder.id, expectedVersion: version }))}
            >
              Submit for approval
            </Button>
          )}

          {purchaseOrder.status === 'PENDING_APPROVAL' && (
            <>
              <Button
                type="button"
                variant="primary"
                disabled={actionPending}
                onClick={() => runAction(() => trpc.purchaseOrders.approve.mutate({ purchaseOrderId: purchaseOrder.id, expectedVersion: version }))}
              >
                Approve
              </Button>
              <Button type="button" variant="ghost" disabled={actionPending} onClick={() => setShowRejectForm((s) => !s)}>
                Reject
              </Button>
            </>
          )}

          {purchaseOrder.status === 'APPROVED' && (
            <Button
              type="button"
              variant="primary"
              disabled={actionPending}
              onClick={() => runAction(() => trpc.purchaseOrders.send.mutate({ purchaseOrderId: purchaseOrder.id, expectedVersion: version }))}
            >
              Send to supplier
            </Button>
          )}

          {(purchaseOrder.status === 'DRAFT' || purchaseOrder.status === 'PENDING_APPROVAL' || purchaseOrder.status === 'APPROVED' || purchaseOrder.status === 'SENT') && (
            <Button
              type="button"
              variant="ghost"
              disabled={actionPending}
              onClick={() => runAction(() => trpc.purchaseOrders.cancel.mutate({ purchaseOrderId: purchaseOrder.id, expectedVersion: version }))}
            >
              Cancel
            </Button>
          )}

          {(purchaseOrder.status === 'SENT' || purchaseOrder.status === 'PARTIALLY_RECEIVED') && (
            <Link href={`/purchase-orders/${purchaseOrder.id}/receive`}>
              <Button type="button" variant="primary">
                Receive delivery
              </Button>
            </Link>
          )}

          {(purchaseOrder.status === 'RECEIVED' || purchaseOrder.status === 'CLOSED' || purchaseOrder.status === 'CANCELLED') && (
            <p className="text-sm text-content-subtle">No further actions — this purchase order is in a terminal state.</p>
          )}
        </div>

        {showRejectForm && (
          <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
            <input
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason (optional)"
              className="w-full max-w-sm rounded-lg border border-border-strong bg-surface-raised px-3 py-1.5 text-sm text-content"
            />
            <Button
              type="button"
              variant="primary"
              disabled={actionPending}
              onClick={() =>
                runAction(() =>
                  trpc.purchaseOrders.reject.mutate({
                    purchaseOrderId: purchaseOrder.id,
                    expectedVersion: version,
                    ...(rejectReason ? { reason: rejectReason } : {}),
                  })
                )
              }
            >
              Confirm reject
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
