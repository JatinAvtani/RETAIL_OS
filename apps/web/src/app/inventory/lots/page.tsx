'use client';

import { Fragment, Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { humanizeEnum } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  Td,
  Th,
  Tr,
  type BadgeTone,
} from '@/components/ui';

type Lot = Awaited<ReturnType<typeof trpc.inventory.lots.query>>[number];

/** Mirrors `/inventory/waste`'s own list — the same real `waste_reason_code` enum both paths write. */
const WASTE_REASONS = [
  'EXPIRED',
  'DAMAGED',
  'PREP_ERROR',
  'CUSTOMER_RETURN',
  'OVERPRODUCTION',
  'SPILLAGE',
  'QUALITY_REJECT',
  'THEFT_SUSPECTED',
] as const;

const STATUS_TONES: Record<string, BadgeTone> = {
  ACTIVE: 'positive',
  DEPLETED: 'neutral',
  EXPIRED: 'danger',
  IN_TRANSIT: 'warning',
};

const daysUntil = (isoDate: string) => {
  const diffMs = new Date(isoDate).getTime() - Date.now();
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
};

function LotsContent() {
  const searchParams = useSearchParams();
  const storeId = searchParams.get('storeId') ?? '';
  const productId = searchParams.get('productId') ?? '';

  const [lots, setLots] = useState<Lot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wasteLotId, setWasteLotId] = useState<string | null>(null);
  const [wasteQuantity, setWasteQuantity] = useState('');
  const [wasteReason, setWasteReason] = useState<(typeof WASTE_REASONS)[number]>('DAMAGED');
  const [wasteSaving, setWasteSaving] = useState(false);
  const [wasteError, setWasteError] = useState<string | null>(null);
  const [wasteResult, setWasteResult] = useState<string | null>(null);

  const reload = () => {
    if (!storeId || !productId) return;
    trpc.inventory.lots.query({ storeId, productId }).then(setLots).catch(() => undefined);
  };

  /**
   * `inventory.logWasteFromLot` — the lot-SPECIFIC waste path, distinct from `/inventory/waste`'s
   * FEFO-ordered one. Its own router comment noted this was left for "a more deliberate
   * lot-detail-page action"; that action never existed, so the procedure had no caller at all.
   * Wasting a NAMED lot is the honest path when the physical thing you're throwing away is a
   * specific delivery (a damaged case, one crate past its date) rather than "N units of this
   * product, oldest first" — FEFO would draw from the wrong lot and misstate that lot's cost.
   */
  const submitWaste = async (lot: Lot) => {
    setWasteError(null);
    setWasteResult(null);
    setWasteSaving(true);
    try {
      await trpc.inventory.logWasteFromLot.mutate({
        storeId,
        productId,
        variantId: lot.variantId,
        lotId: lot.id,
        quantity: wasteQuantity,
        reasonCode: wasteReason,
      });
      setWasteResult(`Logged ${wasteQuantity} from this lot as ${humanizeEnum(wasteReason)}.`);
      setWasteLotId(null);
      setWasteQuantity('');
      reload();
    } catch (err) {
      // The API returns a real, specific shortfall message when the quantity exceeds what's left —
      // surfacing it verbatim beats a generic failure the user can't act on.
      setWasteError(err instanceof TRPCClientError ? err.message : 'Could not log waste for this lot.');
    } finally {
      setWasteSaving(false);
    }
  };

  useEffect(() => {
    if (!storeId || !productId) {
      setError('Missing storeId/productId — open this page via a link from Stock levels.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    trpc.inventory.lots
      .query({ storeId, productId })
      .then(setLots)
      .catch(() => setError('Could not load lots.'))
      .finally(() => setLoading(false));
  }, [storeId, productId]);

  return (
    <>
      <PageHeader
        title="Lots"
        description="Each delivery, tracked on its own. Oldest stock is used first."
        actions={
          <Link href="/inventory">
            <Button variant="ghost">Back</Button>
          </Link>
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      {wasteResult && (
        <div
          role="status"
          className="mb-4 rounded-card border border-positive/30 bg-positive-soft px-4 py-3 text-sm text-positive"
        >
          {wasteResult}
        </div>
      )}

      {!error && (
        <Card>
          {loading && <SkeletonRows columns={6} />}
          {!loading && lots.length === 0 && (
            <EmptyState title="No lots recorded" hint="Lots appear here once goods are received." />
          )}
          {!loading && lots.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <Th>Lot</Th>
                  <Th>Status</Th>
                  <Th align="right">Remaining</Th>
                  <Th align="right">Unit cost</Th>
                  <Th>Received</Th>
                  <Th>Expiry</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {lots.map((lot) => {
                  const daysLeft = lot.expiryDate ? daysUntil(lot.expiryDate) : null;
                  const expiringSoon =
                    daysLeft !== null && daysLeft <= 7 && lot.status === 'ACTIVE';
                  return (
                    <Fragment key={lot.id}>
                    <Tr>
                      <Td className="font-medium">
                        {lot.lotNumber ?? (
                          <span className="text-content-subtle">{lot.id.slice(0, 8)}…</span>
                        )}
                      </Td>
                      <Td>
                        <Badge tone={STATUS_TONES[lot.status] ?? 'neutral'}>
                          {humanizeEnum(lot.status)}
                        </Badge>
                      </Td>
                      <Td variant="numeric">
                        {lot.remainingQuantity}
                      </Td>
                      <Td variant="numeric">
                        {lot.unitCost}
                      </Td>
                      <Td className="text-content-muted">
                        {new Date(lot.receivedAt).toLocaleDateString()}
                      </Td>
                      <Td>
                        {lot.expiryDate ? (
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-content-muted">{lot.expiryDate}</span>
                            {expiringSoon && (
                              <Badge tone={daysLeft <= 0 ? 'danger' : 'warning'}>
                                {daysLeft <= 0 ? 'expired' : `${daysLeft}d left`}
                              </Badge>
                            )}
                          </span>
                        ) : (
                          <span className="italic text-unknown">No expiry set</span>
                        )}
                      </Td>
                      <Td>
                        <div className="flex items-center justify-end gap-3">
                          {/* This cost's real provenance — every lot posted by the invoice pipeline carries the source document directly, no document_links lookup needed for this one entity type. A manually-created lot (no source document) shows nothing here, honestly — I7 applied to a link, not a number. */}
                          {lot.sourceDocumentId ? (
                            <Link href={`/documents/${lot.sourceDocumentId}`} className="text-sm font-medium text-accent hover:underline">
                              Source document
                            </Link>
                          ) : null}
                          {/* Only an ACTIVE lot with stock left can be wasted — a depleted or
                              already-expired lot has nothing to write off, and offering the action
                              anyway would just produce a guaranteed API error. */}
                          {lot.status === 'ACTIVE' && Number(lot.remainingQuantity) > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                setWasteLotId(wasteLotId === lot.id ? null : lot.id);
                                setWasteError(null);
                                setWasteResult(null);
                                setWasteQuantity('');
                              }}
                              className="text-sm font-medium text-accent hover:underline"
                            >
                              {wasteLotId === lot.id ? 'Cancel' : 'Log waste'}
                            </button>
                          )}
                        </div>
                      </Td>
                    </Tr>
                    {wasteLotId === lot.id && (
                      <tr>
                        <td colSpan={7} className="border-b border-border bg-surface-sunken px-4 py-3">
                          <div className="flex flex-wrap items-end gap-3">
                            <Field label="Quantity to write off">
                              <Input
                                value={wasteQuantity}
                                onChange={(event) => setWasteQuantity(event.target.value)}
                                placeholder={`up to ${lot.remainingQuantity}`}
                                className="w-36"
                              />
                            </Field>
                            <Field label="Reason">
                              <Select
                                value={wasteReason}
                                onChange={(event) => setWasteReason(event.target.value as typeof wasteReason)}
                                className="w-48"
                              >
                                {WASTE_REASONS.map((reason) => (
                                  <option key={reason} value={reason}>
                                    {humanizeEnum(reason)}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                            <Button
                              type="button"
                              variant="primary"
                              disabled={wasteSaving || !wasteQuantity.trim()}
                              onClick={() => void submitWaste(lot)}
                            >
                              {wasteSaving ? 'Logging…' : 'Log waste'}
                            </Button>
                          </div>
                          {wasteError && (
                            <p role="alert" className="mt-2 text-xs font-medium text-danger">
                              {wasteError}
                            </p>
                          )}
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}

export default function LotsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <LotsContent />
    </Suspense>
  );
}
