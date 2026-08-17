'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  LoadingState,
  PageHeader,
  SkeletonRows,
  Table,
  Td,
  Th,
  Tr,
  type BadgeTone,
} from '@/components/ui';

type Lot = Awaited<ReturnType<typeof trpc.inventory.lots.query>>[number];

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
                    <Tr key={lot.id}>
                      <Td className="font-medium">
                        {lot.lotNumber ?? (
                          <span className="text-content-subtle">{lot.id.slice(0, 8)}…</span>
                        )}
                      </Td>
                      <Td>
                        <Badge tone={STATUS_TONES[lot.status] ?? 'neutral'}>
                          {lot.status.toLowerCase().replace(/_/g, ' ')}
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
                        {/* 007-12: this cost's real provenance — every lot posted by the invoice pipeline (007-11) carries the source document directly, no document_links lookup needed for this one entity type. A manually-created lot (no source document) shows nothing here, honestly — I7 applied to a link, not a number. */}
                        {lot.sourceDocumentId ? (
                          <Link href={`/documents/${lot.sourceDocumentId}`} className="text-sm font-medium text-accent hover:underline">
                            Source document
                          </Link>
                        ) : null}
                      </Td>
                    </Tr>
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
