'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  LoadingState,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
  Tr,
  Value,
} from '@/components/ui';

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
    <>
      <PageHeader
        title="Stock levels"
        description="What's on hand right now, projected from the movement ledger — every number here traces back to a recorded movement."
        actions={
          <div className="flex items-center gap-2">
            {!storesLoading && stores.length > 0 && (
              <Select
                value={selectedStoreId}
                onChange={(event) => setSelectedStoreId(event.target.value)}
                className="w-auto"
              >
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </Select>
            )}
            <Link href="/inventory/waste">
              <Button>Log waste</Button>
            </Link>
            <Link href="/inventory/stocktake">
              <Button variant="primary">Stocktakes</Button>
            </Link>
          </div>
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <Card>
        {(loading || storesLoading) && <LoadingState />}
        {!storesLoading && stores.length === 0 && <EmptyState title="No stores available." />}
        {!loading && !error && stores.length > 0 && levels.length === 0 && (
          <EmptyState
            title="No stock recorded yet"
            hint="Stock appears here once goods are received or counted."
          />
        )}
        {!loading && !error && levels.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Product</Th>
                <Th align="right">On hand</Th>
                <Th align="right">Avg unit cost</Th>
                <Th>Last movement</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {levels.map((level) => {
                const negative = Number(level.quantity) < 0;
                return (
                  <Tr key={`${level.productId}-${level.variantId}`}>
                    <Td className="font-medium">
                      {productsById.get(level.productId)?.name ?? (
                        <span className="text-content-subtle">{level.productId.slice(0, 8)}…</span>
                      )}
                    </Td>
                    <Td align="right">
                      <span className={negative ? 'tabular font-medium text-danger' : 'tabular'}>
                        {level.quantity}
                      </span>
                    </Td>
                    <Td align="right">
                      <Value value={level.avgUnitCost} />
                    </Td>
                    <Td className="text-content-muted">
                      {level.lastMovementAt ? (
                        new Date(level.lastMovementAt).toLocaleString()
                      ) : (
                        <span className="text-content-subtle">—</span>
                      )}
                    </Td>
                    <Td align="right">
                      <div className="flex justify-end gap-3 text-sm font-medium">
                        <Link
                          href={`/inventory/movements?storeId=${selectedStoreId}&productId=${level.productId}&variantId=${level.variantId}`}
                          className="text-accent hover:underline"
                        >
                          Movements
                        </Link>
                        <Link
                          href={`/inventory/lots?storeId=${selectedStoreId}&productId=${level.productId}`}
                          className="text-accent hover:underline"
                        >
                          Lots
                        </Link>
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
