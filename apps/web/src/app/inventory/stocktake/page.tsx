'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { TRPCClientError } from '@trpc/client';
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

type Category = Awaited<ReturnType<typeof trpc.categories.list.query>>[number];
type StorageLocation = Awaited<ReturnType<typeof trpc.storageLocations.listForStore.query>>[number];

export default function StocktakeListPage() {
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCreatedId, setLastCreatedId] = useState<string | null>(null);
  const [scope, setScope] = useState<'full' | 'category' | 'storageLocation'>('full');
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [storageLocations, setStorageLocations] = useState<StorageLocation[]>([]);
  const [storageLocationId, setStorageLocationId] = useState('');
  const [newLocationName, setNewLocationName] = useState('');
  const [addingLocation, setAddingLocation] = useState(false);

  useEffect(() => {
    trpc.categories.list.query().then(setCategories).catch(() => setCategories([]));
  }, []);

  // Storage locations are scoped to ONE store (a walk-in fridge is a physical place inside a
  // specific store), unlike categories which are org-wide — so this refetches per store and resets
  // the selection, or a location from the previous store would stay selected and fail server-side.
  useEffect(() => {
    if (!selectedStoreId) return;
    setStorageLocationId('');
    trpc.storageLocations.listForStore
      .query({ storeId: selectedStoreId })
      .then(setStorageLocations)
      .catch(() => setStorageLocations([]));
  }, [selectedStoreId]);

  /**
   * Storage locations are created here rather than on a settings page of their own: they exist
   * solely to scope a stocktake, and a user who needs one discovers that at exactly this moment.
   * A newly added location is selected immediately, since adding one is only ever a step towards
   * counting it.
   */
  const handleAddLocation = async () => {
    const name = newLocationName.trim();
    if (!name) return;
    setError(null);
    setAddingLocation(true);
    try {
      const created = await trpc.storageLocations.create.mutate({ storeId: selectedStoreId, name });
      setStorageLocations((current) => [...current, created]);
      setStorageLocationId(created.id);
      setNewLocationName('');
    } catch (err) {
      setError(err instanceof TRPCClientError ? err.message : 'Could not add the storage location.');
    } finally {
      setAddingLocation(false);
    }
  };

  const handleCreate = async () => {
    setError(null);
    setCreating(true);
    try {
      if (scope === 'category') {
        if (!categoryId) {
          setError('Pick a category to count.');
          return;
        }
        const count = await trpc.stocktake.createByCategory.mutate({ storeId: selectedStoreId, categoryId });
        setLastCreatedId(count.id);
        return;
      }

      if (scope === 'storageLocation') {
        if (!storageLocationId) {
          setError('Pick a storage location to count.');
          return;
        }
        const count = await trpc.stocktake.createByStorageLocation.mutate({
          storeId: selectedStoreId,
          storageLocationId,
        });
        setLastCreatedId(count.id);
        return;
      }

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
    } catch (err) {
      // A category with no stocked products is a real, specific outcome the API distinguishes —
      // surfacing its own message beats a generic failure that leaves the user guessing.
      const message = err instanceof TRPCClientError ? err.message : 'Could not create a stock count.';
      setError(message);
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
        description="Starting a count locks in the numbers, so sales during the count don't throw it off."
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

            <Field
              label="What to count"
              hint="A narrower count is faster to walk and easier to finish in one go."
            >
              <Select
                value={scope}
                onChange={(event) => setScope(event.target.value as 'full' | 'category' | 'storageLocation')}
              >
                <option value="full">Everything with recorded stock</option>
                <option value="category">One category</option>
                <option value="storageLocation">One storage location</option>
              </Select>
            </Field>

            {scope === 'category' && (
              <Field
                label="Category"
                hint={
                  <Link href="/categories" className="font-medium text-accent hover:underline">
                    Manage categories
                  </Link>
                }
              >
                <Select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                  <option value="">Select a category…</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            {scope === 'storageLocation' && (
              <Field
                label="Storage location"
                /* An empty list is a real state with a real cause: storage locations are created
                   here and nowhere else, so a store that has none simply hasn't had one added yet.
                   Saying that beats an empty dropdown the user cannot explain. */
                hint={
                  storageLocations.length === 0
                    ? 'This store has no storage locations yet. Add one below to count by physical zone.'
                    : 'Counts only what is stored in this zone — a walk-in, a dry store, a bar well.'
                }
              >
                <Select
                  value={storageLocationId}
                  onChange={(event) => setStorageLocationId(event.target.value)}
                  disabled={storageLocations.length === 0}
                >
                  <option value="">Select a storage location…</option>
                  {storageLocations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            {scope === 'storageLocation' && (
              <Field label="Add a storage location" hint="Name a physical zone in this store, e.g. “Walk-in fridge”.">
                <div className="flex gap-2">
                  <Input
                    value={newLocationName}
                    onChange={(event) => setNewLocationName(event.target.value)}
                    placeholder="Walk-in fridge"
                  />
                  <Button type="button" onClick={handleAddLocation} disabled={addingLocation || !newLocationName.trim()}>
                    {addingLocation ? 'Adding…' : 'Add'}
                  </Button>
                </div>
              </Field>
            )}

            <Button
              type="button"
              variant="primary"
              onClick={handleCreate}
              disabled={creating}
              className="w-full"
            >
              {creating
                ? 'Creating…'
                : scope === 'category'
                  ? 'Start a category count'
                  : scope === 'storageLocation'
                    ? 'Start a location count'
                    : 'Start a full count'}
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}
