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
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';

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
    <>
      <PageHeader
        title="Stocktakes"
        description="Starting a count freezes the theoretical balance at that moment, so sales during the count don't show up as phantom variance."
        actions={
          <Link href="/inventory">
            <Button variant="ghost">Back</Button>
          </Link>
        }
      />

      {storesLoading && <LoadingState />}

      {!storesLoading && stores.length > 0 && (
        <Card className="max-w-lg p-6">
          <div className="space-y-5">
            {error && <ErrorNotice>{error}</ErrorNotice>}
            {lastCreatedId && (
              <div
                role="status"
                className="flex items-center justify-between gap-3 rounded-card border border-positive/30 bg-positive-soft px-4 py-3 text-sm text-positive"
              >
                <span>Count sheet created.</span>
                <Link
                  href={`/inventory/stocktake/${lastCreatedId}`}
                  className="font-medium underline underline-offset-2"
                >
                  Open it
                </Link>
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

            <Button
              type="button"
              variant="primary"
              onClick={handleCreateFull}
              disabled={creating}
              className="w-full"
            >
              {creating ? 'Creating…' : 'Start a full count'}
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}
