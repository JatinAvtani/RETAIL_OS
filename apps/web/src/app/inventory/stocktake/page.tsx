'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';

export default function StocktakeListPage() {
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCreatedId, setLastCreatedId] = useState<string | null>(null);

  const handleCreateFull = async () => {
    setError(null);
    setCreating(true);
    try {
      // A real full count needs at least one product/variant pair — sourced from the store's
      // current stock levels, the same source the waste page uses, since a full count only makes
      // sense over products this store has ever recorded stock for.
      const levels = await trpc.inventory.levels.query({ storeId: selectedStoreId });
      if (levels.length === 0) {
        setError('This store has no recorded stock yet — nothing to count.');
        return;
      }
      const count = await trpc.stocktake.createFull.mutate({
        storeId: selectedStoreId,
        productVariantPairs: levels.map((level) => ({ productId: level.productId, variantId: level.variantId })),
      });
      setLastCreatedId(count.id);
    } catch {
      setError('Could not create a stock count.');
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    setLastCreatedId(null);
  }, [selectedStoreId]);

  return (
    <main>
      <h1>Stocktakes</h1>
      <nav>
        <Link href="/inventory">Back to stock levels</Link>
      </nav>

      {storesLoading && <p>Loading stores...</p>}
      {!storesLoading && stores.length > 0 && (
        <>
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
          <br />
          <button type="button" onClick={handleCreateFull} disabled={creating}>
            {creating ? 'Creating...' : 'Start a full count'}
          </button>
        </>
      )}

      {error && <p role="alert">{error}</p>}
      {lastCreatedId && (
        <p role="status">
          Count created. <Link href={`/inventory/stocktake/${lastCreatedId}`}>Open it</Link>
        </p>
      )}
    </main>
  );
}
