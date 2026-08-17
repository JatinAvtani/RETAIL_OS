'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { Button, Card, ErrorNotice, Field, Input, LoadingState, PageHeader, Select, Table, Td, Th, Tr } from '@/components/ui';

type GetPoResult = Awaited<ReturnType<typeof trpc.purchaseOrders.get.query>>;
type PoLine = GetPoResult['lines'][number];
type Product = Awaited<ReturnType<typeof trpc.products.list.query>>[number];
type GoodsReceiptLine = Awaited<ReturnType<typeof trpc.goodsReceipts.get.query>>['lines'][number];

const DISCREPANCY_CODES = ['SHORT', 'OVER', 'DAMAGED', 'WRONG_ITEM', 'LATE'] as const;

type LineDraft = {
  receivedQuantityBaseUnits: string;
  lotNumber: string;
  expiryDate: string;
  discrepancyCode: (typeof DISCREPANCY_CODES)[number] | '';
  discrepancyNotes: string;
};

/**
 * 008-07 (plan.md Phase 3, spec 05 §5.2.3): a real delivery arrives, a manager records what
 * actually showed up per PO line — received qty (defaults to what's still outstanding), lot
 * number, expiry, and a discrepancy code if something's off. Every line still un-fully-received
 * (per `quantityBaseUnits` minus the PO line's own `receivedQuantityBaseUnits`, which accumulates
 * across every prior receipt against this PO) is offered; a line already fully received is hidden
 * — there's nothing left to record against it.
 */
export default function ReceivePurchaseOrderPage() {
  const params = useParams<{ purchaseOrderId: string }>();
  const router = useRouter();
  const [po, setPo] = useState<GetPoResult | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [discrepancyLines, setDiscrepancyLines] = useState<GoodsReceiptLine[] | null>(null);
  const [uploadingLineId, setUploadingLineId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      trpc.purchaseOrders.get.query({ purchaseOrderId: params.purchaseOrderId }),
      trpc.products.list.query(),
    ])
      .then(([poResult, productsResult]) => {
        setPo(poResult);
        setProducts(productsResult);
        const outstanding = poResult.lines.filter(remainingBaseUnits);
        const initialDrafts: Record<string, LineDraft> = {};
        for (const line of outstanding) {
          initialDrafts[line.id] = {
            receivedQuantityBaseUnits: remainingBaseUnits(line),
            lotNumber: '',
            expiryDate: '',
            discrepancyCode: '',
            discrepancyNotes: '',
          };
        }
        setDrafts(initialDrafts);
      })
      .catch(() => setError('Could not load this purchase order.'))
      .finally(() => setLoading(false));
  }, [params.purchaseOrderId]);

  useEffect(() => {
    load();
  }, [load]);

  const updateDraft = (lineId: string, patch: Partial<LineDraft>) => {
    setDrafts((current) => ({ ...current, [lineId]: { ...current[lineId]!, ...patch } }));
  };

  const handleSubmit = async () => {
    if (!po) return;
    setError(null);
    setSubmitting(true);
    try {
      const lines = Object.entries(drafts)
        .filter(([, draft]) => draft.receivedQuantityBaseUnits.trim().length > 0 && Number(draft.receivedQuantityBaseUnits) > 0)
        .map(([purchaseOrderLineId, draft], index) => ({
          purchaseOrderLineId,
          receivedQuantityBaseUnits: draft.receivedQuantityBaseUnits,
          lineNumber: index + 1,
          ...(draft.lotNumber ? { lotNumber: draft.lotNumber } : {}),
          ...(draft.expiryDate ? { expiryDate: draft.expiryDate } : {}),
          ...(draft.discrepancyCode ? { discrepancyCode: draft.discrepancyCode } : {}),
          ...(draft.discrepancyNotes ? { discrepancyNotes: draft.discrepancyNotes } : {}),
        }));

      if (lines.length === 0) {
        setError('Enter a received quantity for at least one line.');
        setSubmitting(false);
        return;
      }

      const result = await trpc.goodsReceipts.confirmReceipt.mutate({
        storeId: po.purchaseOrder.storeId,
        purchaseOrderId: po.purchaseOrder.id,
        supplierId: po.purchaseOrder.supplierId,
        receivedAt: new Date().toISOString(),
        lines,
      });

      // A goods_receipt_line's real id only exists AFTER confirmReceipt creates it — photo upload
      // (008-08) needs that real id, so a line with a discrepancy code gets a follow-up "attach
      // photos" step on this same page rather than navigating away immediately. A clean receipt
      // (no discrepancies) has nothing to photograph and goes straight back to the PO.
      const anyDiscrepancy = lines.some((l) => l.discrepancyCode !== undefined);
      if (anyDiscrepancy) {
        const receipt = await trpc.goodsReceipts.get.query({ goodsReceiptId: result.goodsReceiptId });
        setDiscrepancyLines(receipt.lines.filter((l) => l.discrepancyCode !== null));
        setSubmitting(false);
      } else {
        router.push(`/purchase-orders/${po.purchaseOrder.id}`);
      }
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Could not confirm this receipt.';
      setError(message);
      setSubmitting(false);
    }
  };

  const uploadPhoto = async (goodsReceiptLineId: string, file: File) => {
    setUploadingLineId(goodsReceiptLineId);
    setError(null);
    try {
      const { uploadUrl, key } = await trpc.goodsReceipts.requestPhotoUpload.mutate({
        goodsReceiptLineId,
        contentType: file.type as 'image/jpeg' | 'image/png' | 'image/webp',
      });
      await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type } });
      await trpc.goodsReceipts.confirmPhotoUpload.mutate({ goodsReceiptLineId, key });
      setDiscrepancyLines((current) =>
        current
          ? current.map((l) =>
              l.id === goodsReceiptLineId
                ? { ...l, photoObjectKeys: [...(Array.isArray(l.photoObjectKeys) ? (l.photoObjectKeys as string[]) : []), key] }
                : l
            )
          : current
      );
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Could not upload this photo.';
      setError(message);
    } finally {
      setUploadingLineId(null);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title="Receive delivery" />
        <Card>
          <LoadingState />
        </Card>
      </>
    );
  }

  if (!po) {
    return (
      <>
        <PageHeader title="Receive delivery" />
        <ErrorNotice>{error ?? 'This purchase order could not be found.'}</ErrorNotice>
      </>
    );
  }

  if (discrepancyLines) {
    const productName = (productId: string) => products.find((p) => p.id === productId)?.name ?? 'Unknown product';
    return (
      <>
        <PageHeader
          title="Attach photos for damage claims"
          description="Optional. A photo helps if you need to raise this with the supplier."
        />
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Product</Th>
                <Th>Discrepancy</Th>
                <Th>Photos</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {discrepancyLines.map((line) => {
                const photoKeys = Array.isArray(line.photoObjectKeys) ? (line.photoObjectKeys as string[]) : [];
                return (
                  <Tr key={line.id}>
                    <Td>{productName(line.productId)}</Td>
                    <Td>{String(line.discrepancyCode).replace(/_/g, ' ')}</Td>
                    <Td>{photoKeys.length} attached</Td>
                    <Td align="right">
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        disabled={uploadingLineId === line.id}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void uploadPhoto(line.id, file);
                          e.target.value = '';
                        }}
                      />
                      {uploadingLineId === line.id && <span className="ml-2 text-xs text-content-subtle">Uploading…</span>}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
        <div className="mt-6">
          <Button type="button" variant="primary" onClick={() => router.push(`/purchase-orders/${po.purchaseOrder.id}`)}>
            Done
          </Button>
        </div>
      </>
    );
  }

  const outstandingLines = po.lines.filter(remainingBaseUnits);
  const productName = (productId: string) => products.find((p) => p.id === productId)?.name ?? 'Unknown product';

  return (
    <>
      <PageHeader
        title={`Receive ${po.purchaseOrder.poNumber}`}
        description="Record what actually arrived."
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      {outstandingLines.length === 0 ? (
        <Card className="p-6">
          <p className="text-sm text-content-subtle">Every line on this purchase order has already been fully received.</p>
        </Card>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Product</Th>
                <Th align="right">Outstanding</Th>
                <Th align="right">Received qty</Th>
                <Th>Lot number</Th>
                <Th>Expiry</Th>
                <Th>Discrepancy</Th>
              </tr>
            </thead>
            <tbody>
              {outstandingLines.map((line) => {
                const draft = drafts[line.id];
                if (!draft) return null;
                return (
                  <Tr key={line.id}>
                    <Td>{productName(line.productId)}</Td>
                    <Td variant="numeric">
                      {remainingBaseUnits(line)}
                    </Td>
                    <Td align="right">
                      <Input
                        type="text"
                        value={draft.receivedQuantityBaseUnits}
                        onChange={(e) => updateDraft(line.id, { receivedQuantityBaseUnits: e.target.value })}
                        className="w-24 text-right"
                      />
                    </Td>
                    <Td>
                      <Input type="text" value={draft.lotNumber} onChange={(e) => updateDraft(line.id, { lotNumber: e.target.value })} className="w-32" />
                    </Td>
                    <Td>
                      <Input type="date" value={draft.expiryDate} onChange={(e) => updateDraft(line.id, { expiryDate: e.target.value })} className="w-36" />
                    </Td>
                    <Td>
                      <Select
                        value={draft.discrepancyCode}
                        onChange={(e) => updateDraft(line.id, { discrepancyCode: e.target.value as LineDraft['discrepancyCode'] })}
                        className="w-32"
                      >
                        <option value="">None</option>
                        {DISCREPANCY_CODES.map((code) => (
                          <option key={code} value={code}>
                            {code.replace(/_/g, ' ')}
                          </option>
                        ))}
                      </Select>
                      {draft.discrepancyCode && (
                        <Field label="Notes">
                          <Input
                            type="text"
                            value={draft.discrepancyNotes}
                            onChange={(e) => updateDraft(line.id, { discrepancyNotes: e.target.value })}
                            placeholder="What happened?"
                          />
                        </Field>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}

      <div className="mt-6 flex items-center gap-2">
        <Button type="button" variant="primary" disabled={submitting || outstandingLines.length === 0} onClick={handleSubmit}>
          {submitting ? 'Confirming…' : 'Confirm receipt'}
        </Button>
        <Link href={`/purchase-orders/${po.purchaseOrder.id}`}>
          <Button type="button" variant="ghost">
            Cancel
          </Button>
        </Link>
      </div>
    </>
  );
}

/** `quantityBaseUnits` (ordered) minus `receivedQuantityBaseUnits` (received so far, null meaning zero — I7 at the schema layer, not this UI's own invention). A line already fully received returns `'0'`, filtered out of the outstanding list. */
function remainingBaseUnits(line: PoLine): string {
  const ordered = Number(line.quantityBaseUnits);
  const received = line.receivedQuantityBaseUnits !== null ? Number(line.receivedQuantityBaseUnits) : 0;
  const remaining = ordered - received;
  return remaining > 0 ? remaining.toString() : '0';
}
