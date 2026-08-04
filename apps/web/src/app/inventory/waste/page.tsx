'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';

type Product = Awaited<ReturnType<typeof trpc.products.list.query>>[number];
type StockLevel = Awaited<ReturnType<typeof trpc.inventory.levels.query>>[number];

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

/**
 * plan.md Phase 7: "waste entry (3 taps, mobile)" — one screen, no navigation between steps: pick
 * the product, pick the reason, enter a quantity, submit. Uses `inventory.logWaste` (the FEFO-
 * default path) — the lot-override path (`logWasteFromLot`) isn't exposed here, since picking a
 * specific lot is the opposite of a 3-tap flow; it stays available as a distinct procedure for a
 * more deliberate lot-detail-page action, not this quick-entry screen.
 */
export default function WastePage() {
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const [products, setProducts] = useState<Map<string, Product>>(new Map());
  // Sourced from inventory.levels, not products.list — products.list has no variant id, and every
  // stock movement (waste included) needs a real productId + variantId pair. A product with no
  // stock_levels row at this store (never received) has no variant to pick here yet, correctly:
  // there is nothing to waste.
  const [levels, setLevels] = useState<StockLevel[]>([]);
  const [variantKey, setVariantKey] = useState('');
  const [reasonCode, setReasonCode] = useState<(typeof WASTE_REASONS)[number]>('SPILLAGE');
  const [quantity, setQuantity] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    trpc.products.list.query().then((all) => {
      setProducts(new Map(all.map((product) => [product.id, product])));
    });
  }, []);

  useEffect(() => {
    if (!selectedStoreId) return;
    trpc.inventory.levels.query({ storeId: selectedStoreId }).then((result) => {
      setLevels(result);
      const first = result[0];
      if (first) setVariantKey(`${first.productId}:${first.variantId}`);
    });
  }, [selectedStoreId]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setResult(null);

    const [productId, variantId] = variantKey.split(':');
    const product = productId ? products.get(productId) : undefined;
    if (!productId || !variantId || !product || !selectedStoreId || !quantity) {
      setError('Pick a product, a store, and enter a quantity.');
      return;
    }

    setSubmitting(true);
    try {
      await trpc.inventory.logWaste.mutate({
        storeId: selectedStoreId,
        productId,
        variantId,
        quantity,
        reasonCode,
      });
      setResult(`Logged ${quantity} of ${product.name} as ${reasonCode}.`);
      setQuantity('');
    } catch {
      setError('Could not log waste — check the quantity against available stock.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main>
      <h1>Log waste</h1>
      <nav>
        <Link href="/inventory">Back to stock levels</Link>
      </nav>

      {storesLoading && <p>Loading stores...</p>}
      {!storesLoading && stores.length > 0 && (
        <form onSubmit={handleSubmit}>
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
          <label>
            Product:{' '}
            <select value={variantKey} onChange={(event) => setVariantKey(event.target.value)}>
              {levels.length === 0 && <option value="">No stock at this store</option>}
              {levels.map((level) => (
                <option key={`${level.productId}:${level.variantId}`} value={`${level.productId}:${level.variantId}`}>
                  {products.get(level.productId)?.name ?? level.productId}
                </option>
              ))}
            </select>
          </label>
          <br />
          <label>
            Reason:{' '}
            <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value as typeof reasonCode)}>
              {WASTE_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {reason}
                </option>
              ))}
            </select>
          </label>
          <br />
          <label>
            Quantity:{' '}
            <input
              type="text"
              inputMode="decimal"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              placeholder="e.g. 2.5"
            />
          </label>
          <br />
          <button type="submit" disabled={submitting}>
            {submitting ? 'Logging...' : 'Log waste'}
          </button>
        </form>
      )}

      {result && <p role="status">{result}</p>}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
