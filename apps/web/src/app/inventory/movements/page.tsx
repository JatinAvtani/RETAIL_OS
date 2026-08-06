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
        description="The append-only ledger for this product. Corrections are new rows, never edits — every past number stays reproducible."
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
          {loading && <LoadingState />}
          {!loading && filtered.length === 0 && (
            <EmptyState
              title="No movements match this filter"
              {...(typeFilter ? { hint: 'Try selecting all types.' } : {})}
            />
          )}
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
                    <Td className="whitespace-nowrap text-content-muted">
                      {new Date(movement.occurredAt).toLocaleString()}
                    </Td>
                    <Td>
                      <Badge tone={MOVEMENT_TONES[movement.movementType] ?? 'neutral'}>
                        {humanize(movement.movementType)}
                      </Badge>
                    </Td>
                    <Td align="right">
                      <span
                        className={
                          Number(movement.quantity) < 0 ? 'tabular text-danger' : 'tabular text-positive'
                        }
                      >
                        {movement.quantity}
                      </span>
                    </Td>
                    <Td align="right">
                      <Value value={movement.unitCost} />
                    </Td>
                    <Td className="text-content-muted">
                      {movement.reasonCode ? humanize(movement.reasonCode) : <span className="text-content-subtle">—</span>}
                    </Td>
                    <Td className="text-content-muted">{humanize(movement.sourceType)}</Td>
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
