'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';

type Lot = Awaited<ReturnType<typeof trpc.inventory.lots.query>>[number];

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
    <main>
      <h1>Lots</h1>
      <nav>
        <Link href="/inventory">Back to stock levels</Link>
      </nav>

      {error && <p role="alert">{error}</p>}
      {loading && <p>Loading...</p>}
      {!loading && !error && lots.length === 0 && <p>No lots recorded for this product at this store.</p>}
      {!loading && !error && lots.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Lot number</th>
              <th>Status</th>
              <th>Remaining</th>
              <th>Unit cost</th>
              <th>Received</th>
              <th>Expiry</th>
            </tr>
          </thead>
          <tbody>
            {lots.map((lot) => {
              const daysLeft = lot.expiryDate ? daysUntil(lot.expiryDate) : null;
              return (
                <tr key={lot.id}>
                  <td>{lot.lotNumber ?? lot.id}</td>
                  <td>{lot.status}</td>
                  <td>{lot.remainingQuantity}</td>
                  <td>{lot.unitCost}</td>
                  <td>{new Date(lot.receivedAt).toLocaleDateString()}</td>
                  <td>
                    {lot.expiryDate ? (
                      <>
                        {lot.expiryDate}
                        {daysLeft !== null && daysLeft <= 7 && lot.status === 'ACTIVE' && (
                          <strong> ({daysLeft <= 0 ? 'expired' : `${daysLeft}d left`})</strong>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}

export default function LotsPage() {
  return (
    <Suspense fallback={<p>Loading...</p>}>
      <LotsContent />
    </Suspense>
  );
}
