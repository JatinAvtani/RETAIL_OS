'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';

type UnmappedItem = Awaited<ReturnType<typeof trpc.posItems.listUnmapped.query>>[number];

/**
 * 006-11 (plan.md Phase 6, the last task in EPIC-006): unmapped POS items ranked by sales volume
 * descending ("mapping the top 20 items covers ~80% of revenue"), each with fuzzy-suggested menu
 * item matches. The human always confirms or ignores explicitly (I9) — nothing here maps
 * automatically, even when a suggestion's score is 1 (an exact name match).
 */
export default function PosItemsPage() {
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const [items, setItems] = useState<UnmappedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!selectedStoreId) return;
    setLoading(true);
    setError(null);
    trpc.posItems.listUnmapped
      .query({ storeId: selectedStoreId })
      .then(setItems)
      .catch(() => setError('Could not load unmapped POS items.'))
      .finally(() => setLoading(false));
  }, [selectedStoreId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleMap = async (posItemId: string, menuItemId: string) => {
    setPendingItemId(posItemId);
    setError(null);
    try {
      await trpc.posItems.mapToMenuItem.mutate({ id: posItemId, menuItemId });
      setItems((current) => current.filter((item) => item.id !== posItemId));
    } catch {
      setError('Could not save that mapping. Try again.');
    } finally {
      setPendingItemId(null);
    }
  };

  const handleIgnore = async (posItemId: string) => {
    setPendingItemId(posItemId);
    setError(null);
    try {
      await trpc.posItems.ignore.mutate({ id: posItemId });
      setItems((current) => current.filter((item) => item.id !== posItemId));
    } catch {
      setError('Could not ignore that item. Try again.');
    } finally {
      setPendingItemId(null);
    }
  };

  return (
    <main>
      <h1>Map POS items</h1>
      <nav>
        <Link href="/products">Products</Link> · <Link href="/recipes">Recipes</Link>
      </nav>
      <p>
        Every item your POS has sold that isn&apos;t linked to a menu item yet, ranked by revenue —
        mapping the top few usually covers most of your sales. Confirm a suggested match, pick a
        different one, or mark an item as not a menu item at all (a gift card, a tip line).
      </p>

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
      {!loading && !error && items.length === 0 && <p>Nothing left to map at this store.</p>}
      {!loading && !error && items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>POS item</th>
              <th>Revenue (trailing)</th>
              <th>Suggested menu item</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const bestSuggestion = item.suggestions[0];
              const isPending = pendingItemId === item.id;
              return (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td>{item.totalRevenue}</td>
                  <td>
                    {item.suggestions.length === 0 && <em>No close match found</em>}
                    {item.suggestions.length > 0 && (
                      <select
                        defaultValue={bestSuggestion?.menuItemId}
                        id={`suggestion-${item.id}`}
                        disabled={isPending}
                      >
                        {item.suggestions.map((suggestion) => (
                          <option key={suggestion.menuItemId} value={suggestion.menuItemId}>
                            {suggestion.name} ({Math.round(suggestion.score * 100)}% match)
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td>
                    {item.suggestions.length > 0 && (
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => {
                          const select = document.getElementById(`suggestion-${item.id}`) as HTMLSelectElement | null;
                          const menuItemId = select?.value ?? bestSuggestion?.menuItemId;
                          if (menuItemId) void handleMap(item.id, menuItemId);
                        }}
                      >
                        Confirm
                      </button>
                    )}
                    {' '}
                    <button type="button" disabled={isPending} onClick={() => void handleIgnore(item.id)}>
                      Not a menu item
                    </button>
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
