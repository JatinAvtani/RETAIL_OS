'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';

type Movement = Awaited<ReturnType<typeof trpc.inventory.movements.query>>[number];

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
    <main>
      <h1>Movement history</h1>
      <nav>
        <Link href="/inventory">Back to stock levels</Link>
      </nav>

      {error && <p role="alert">{error}</p>}

      {!error && (
        <label>
          Filter by type:{' '}
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
            <option value="">All types</option>
            {MOVEMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
      )}

      {loading && <p>Loading...</p>}
      {!loading && !error && filtered.length === 0 && <p>No movements match this filter.</p>}
      {!loading && !error && filtered.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Occurred</th>
              <th>Type</th>
              <th>Quantity</th>
              <th>Unit cost</th>
              <th>Reason</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((movement) => (
              <tr key={movement.id}>
                <td>{new Date(movement.occurredAt).toLocaleString()}</td>
                <td>{movement.movementType}</td>
                <td>{movement.quantity}</td>
                <td>{movement.unitCost ?? 'Unknown'}</td>
                <td>{movement.reasonCode ?? '—'}</td>
                <td>{movement.sourceType}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

export default function MovementsPage() {
  return (
    <Suspense fallback={<p>Loading...</p>}>
      <MovementsContent />
    </Suspense>
  );
}
