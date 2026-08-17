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
  Select,
  Table,
  Td,
  Th,
  Tr,
  Value,
  type BadgeTone,
} from '@/components/ui';

type Movement = Awaited<ReturnType<typeof trpc.inventory.movements.query>>[number];

/** Stock-increasing movements read positive, stock-reducing read as a loss — the tone makes a
 *  ledger scannable at a glance without having to parse the sign of every quantity. */
const MOVEMENT_TONES: Record<string, BadgeTone> = {
  RECEIPT: 'positive',
  TRANSFER_IN: 'positive',
  PRODUCTION_OUTPUT: 'positive',
  SALE_CONSUMPTION: 'neutral',
  PRODUCTION_INPUT: 'neutral',
  COUNT_ADJUSTMENT: 'warning',
  WASTE: 'danger',
  TRANSFER_OUT: 'neutral',
  RETURN_TO_SUPPLIER: 'warning',
};

const humanize = (value: string) => value.toLowerCase().replace(/_/g, ' ');

const MOVEMENT_TYPES = [
  'RECEIPT',
  'SALE_CONSUMPTION',
  'WASTE',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'COUNT_ADJUSTMENT',
  'PRODUCTION_INPUT',
  'PRODUCTION_OUTPUT',
  'RETURN_TO_SUPPLIER',
] as const;

function MovementsContent() {
  const searchParams = useSearchParams();
  const storeId = searchParams.get('storeId') ?? '';
  const productId = searchParams.get('productId') ?? '';
  const variantId = searchParams.get('variantId') ?? '';

  const [movements, setMovements] = useState<Movement[]>([]);
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId || !productId || !variantId) {
      setError('Missing storeId/productId/variantId — open this page via a link from Stock levels.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    trpc.inventory.movements
      .query({ storeId, productId, variantId })
      .then(setMovements)
      .catch(() => setError('Could not load movement history.'))
      .finally(() => setLoading(false));
  }, [storeId, productId, variantId]);

  const filtered = typeFilter ? movements.filter((m) => m.movementType === typeFilter) : movements;

  return (
    <>
      <PageHeader
        title="Movement history"
        description="Full history for this product. Nothing here is ever edited, only added."
        actions={
          <div className="flex items-center gap-2">
            {!error && (
              <Select
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value)}
                className="w-auto"
              >
                <option value="">All types</option>
                {MOVEMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {humanize(type)}
                  </option>
                ))}
              </Select>
            )}
            <Link href="/inventory">
              <Button variant="ghost">Back</Button>
            </Link>
          </div>
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      {!error && (
        <Card>
          {loading && <SkeletonRows columns={6} />}
          {!loading && filtered.length === 0 &&
            (typeFilter ? (
              <EmptyState
                variant="no-matches"
                title="No movements of this type"
                hint="The ledger still holds every other movement in this period."
                action={
                  <Button variant="secondary" onClick={() => setTypeFilter('')}>
                    Show all types
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No movements recorded"
                hint="Stock movements appear here as goods are received, sold, wasted or counted."
              />
            ))}
          {!loading && filtered.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <Th>Occurred</Th>
                  <Th>Type</Th>
                  <Th align="right">Quantity</Th>
                  <Th align="right">Unit cost</Th>
                  <Th>Reason</Th>
                  <Th>Source</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((movement) => (
                  <Tr key={movement.id}>
                    <Td className="whitespace-nowrap font-mono text-content-muted">
                      {new Date(movement.occurredAt).toLocaleString()}
                    </Td>
                    <Td>
                      <Badge tone={MOVEMENT_TONES[movement.movementType] ?? 'neutral'}>
                        {humanize(movement.movementType)}
                      </Badge>
                    </Td>
                    {/* Deliberately not red-for-out / green-for-in: stock leaving on a sale is the
                        business working, not a problem. The sign already carries the direction, and
                        the movement type beside it carries the meaning. */}
                    <Td variant="numeric">{movement.quantity}</Td>
                    <Td variant="numeric">
                      <Value value={movement.unitCost} />
                    </Td>
                    <Td className="capitalize text-content-muted">
                      {movement.reasonCode ? humanize(movement.reasonCode) : <span className="text-content-subtle">Not set</span>}
                    </Td>
                    <Td className="capitalize text-content-muted">{humanize(movement.sourceType)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}

export default function MovementsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <MovementsContent />
    </Suspense>
  );
}
