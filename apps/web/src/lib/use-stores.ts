'use client';

import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';

type Store = Awaited<ReturnType<typeof trpc.stores.list.query>>[number];

/** Every inventory page is store-scoped, not just org-scoped — this loads the caller's visible stores (already object-level filtered server-side by `canAccessStore`) and tracks which one is selected, shared across every /inventory page rather than duplicated per page. */
export const useStores = () => {
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    trpc.stores.list
      .query()
      .then((result) => {
        setStores(result);
        if (result.length > 0 && result[0]) {
          setSelectedStoreId(result[0].id);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  return { stores, selectedStoreId, setSelectedStoreId, loading };
};
