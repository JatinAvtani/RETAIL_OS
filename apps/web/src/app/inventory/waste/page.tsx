'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import {
  Button,
  Card,
  ErrorNotice,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';

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
    <>
      <PageHeader
        title="Log waste"
        description="Quick entry for spoilage, spillage, and prep errors. Stock is drawn from the earliest-expiring lot automatically."
        actions={
          <Link href="/inventory">
            <Button variant="ghost">Back</Button>
          </Link>
        }
      />

      {storesLoading && <LoadingState />}

      {!storesLoading && stores.length > 0 && (
        <Card className="max-w-lg p-6">
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && <ErrorNotice>{error}</ErrorNotice>}
            {result && (
              <div
                role="status"
                className="rounded-card border border-positive/30 bg-positive-soft px-4 py-3 text-sm text-positive"
              >
                {result}
              </div>
            )}

            <Field label="Store">
              <Select
                value={selectedStoreId}
                onChange={(event) => setSelectedStoreId(event.target.value)}
              >
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Product" hint="Only products with stock at this store can be wasted.">
              <Select value={variantKey} onChange={(event) => setVariantKey(event.target.value)}>
                {levels.length === 0 && <option value="">No stock at this store</option>}
                {levels.map((level) => (
                  <option
                    key={`${level.productId}:${level.variantId}`}
                    value={`${level.productId}:${level.variantId}`}
                  >
                    {products.get(level.productId)?.name ?? level.productId}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Reason">
              <Select
                value={reasonCode}
                onChange={(event) => setReasonCode(event.target.value as typeof reasonCode)}
              >
                {WASTE_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {reason.toLowerCase().replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Quantity">
              <Input
                type="text"
                inputMode="decimal"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                placeholder="e.g. 2.5"
              />
            </Field>

            <Button
              type="submit"
              variant="primary"
              disabled={submitting || levels.length === 0}
              className="w-full"
            >
              {submitting ? 'Logging…' : 'Log waste'}
            </Button>
          </form>
        </Card>
      )}
    </>
  );
}
