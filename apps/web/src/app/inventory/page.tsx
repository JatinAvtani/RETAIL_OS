'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';

type StockLevel = Awaited<ReturnType<typeof trpc.inventory.levels.query>>[number];
type Product = Awaited<ReturnType<typeof trpc.products.list.query>>[number];

export default function InventoryPage() {
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const [levels, setLevels] = useState<StockLevel[]>([]);
  const [productsById, setProductsById] = useState<Map<string, Product>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    trpc.products.list.query().then((products) => {
      setProductsById(new Map(products.map((product) => [product.id, product])));
    });
  }, []);

  useEffect(() => {
    if (!selectedStoreId) return;
    setLoading(true);
    setError(null);
    trpc.inventory.levels
      .query({ storeId: selectedStoreId })
      .then(setLevels)
      .catch(() => setError('Could not load stock levels.'))
      .finally(() => setLoading(false));
  }, [selectedStoreId]);

  return (
    <main>
      <h1>Stock levels</h1>
      <nav>
        <Link href="/products">Products</Link> · <Link href="/inventory/waste">Log waste</Link> ·{' '}
        <Link href="/inventory/stocktake">Stocktakes</Link>
      </nav>

      {storesLoading && <p>Loading stores...</p>}
      {!storesLoading && stores.length === 0 && <p>No stores available.</p>}
      {!storesLoading && stores.length > 0 && (
        <label>
          Store:{' '}
          <select value={selectedStoreId} onChange={(event) => setSelectedStoreId(event.target.value)}>
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {loading && <p>Loading...</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && levels.length === 0 && <p>No stock recorded at this store yet.</p>}
      {!loading && !error && levels.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Quantity</th>
              <th>Avg unit cost</th>
              <th>Last movement</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {levels.map((level) => (
              <tr key={`${level.productId}-${level.variantId}`}>
                <td>{productsById.get(level.productId)?.name ?? level.productId}</td>
                <td>{level.quantity}</td>
                <td>{level.avgUnitCost ?? 'Unknown'}</td>
                <td>{level.lastMovementAt ? new Date(level.lastMovementAt).toLocaleString() : '—'}</td>
                <td>
                  <Link
                    href={`/inventory/movements?storeId=${selectedStoreId}&productId=${level.productId}&variantId=${level.variantId}`}
                  >
                    Movements
                  </Link>
                  {' · '}
                  <Link href={`/inventory/lots?storeId=${selectedStoreId}&productId=${level.productId}`}>Lots</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
