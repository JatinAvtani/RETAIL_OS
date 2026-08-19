'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import { formatMoney, formatQuantityDisplay } from '@/lib/format';
import { useOrgCurrency } from '@/lib/use-org-currency';
import {
  cx,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SkeletonRows,
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
  const orgCurrency = useOrgCurrency();
  const [levels, setLevels] = useState<StockLevel[]>([]);
  const [productsById, setProductsById] = useState<Map<string, Product>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Unit codes, id → code. An on-hand figure without its unit is off by 1000× in the reader's
  // head depending on whether they assume grams or kilograms — the label is part of the number.
  const [unitCodeById, setUnitCodeById] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    trpc.products.list.query().then((products) => {
      setProductsById(new Map(products.map((product) => [product.id, product])));
    });
    trpc.units.list.query().then((units) => {
      setUnitCodeById(new Map(units.map((unit) => [unit.id, unit.code])));
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
        description="What's on hand right now."
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
        {(loading || storesLoading) && <SkeletonRows columns={5} />}
        {!storesLoading && stores.length === 0 && <EmptyState title="No stores available." />}
        {!loading && !error && stores.length > 0 && levels.length === 0 && (
          <EmptyState
            title="No stock recorded yet"
            hint="Stock appears here once goods are received or counted."
          />
        )}
        {/* Below the sm breakpoint the five-column table has ~70px per column — every header
            wraps and every figure splits across lines, which is worse than useless for a number
            you're checking against a shelf. Reflow to one card per product instead; the table
            stays the desktop form. */}
        {!loading && !error && levels.length > 0 && (
          <ul className="divide-y divide-border sm:hidden">
            {levels.map((level) => {
              const baseUnitId = productsById.get(level.productId)?.baseUnitId;
              const unitCode = baseUnitId ? (unitCodeById.get(baseUnitId) ?? null) : null;
              const { text, exact } = formatQuantityDisplay(level.quantity, unitCode);
              const negative = Number(level.quantity) < 0;
              return (
                <li key={`${level.productId}-${level.variantId}`} className="px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-content">
                      {productsById.get(level.productId)?.name ?? (
                        <span className="font-mono text-content-subtle">{level.productId.slice(0, 8)}…</span>
                      )}
                    </span>
                    <span
                      title={exact}
                      className={cx('font-mono text-sm', negative ? 'font-semibold text-danger' : 'text-content')}
                    >
                      {text}
                    </span>
                  </div>
                  <div className="mt-1 flex items-baseline justify-between gap-3 text-xs text-content-muted">
                    <span>
                      Avg cost:{' '}
                      {level.avgUnitCost !== null ? (
                        <span className="font-mono">{formatMoney(level.avgUnitCost, orgCurrency)}</span>
                      ) : (
                        <span className="italic text-unknown">Not known</span>
                      )}
                    </span>
                    <span className="flex gap-3 font-medium">
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
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {!loading && !error && levels.length > 0 && (
          <Table className="hidden sm:block">
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
                // Negative on-hand is a real data anomaly, not just a small number — it rides as a
                // row severity stripe rather than a recoloured digit, so the figure stays as
                // readable as every other figure in the column.
                return (
                  <Tr key={`${level.productId}-${level.variantId}`} {...(negative ? { severity: 'short' as const } : {})}>
                    <Td className="font-medium">
                      {productsById.get(level.productId)?.name ?? (
                        <span className="font-mono text-content-subtle">{level.productId.slice(0, 8)}…</span>
                      )}
                    </Td>
                    <Td variant="numeric">
                      {(() => {
                        const baseUnitId = productsById.get(level.productId)?.baseUnitId;
                        const unitCode = baseUnitId ? (unitCodeById.get(baseUnitId) ?? null) : null;
                        const { text, exact } = formatQuantityDisplay(level.quantity, unitCode);
                        // The exact stored figure stays inspectable on hover — display rounding
                        // must never become the only version of the number anyone can see.
                        return <span title={exact}>{text}</span>;
                      })()}
                    </Td>
                    <Td variant="numeric">
                      <Value
                        value={
                          level.avgUnitCost !== null
                            ? formatMoney(level.avgUnitCost, orgCurrency)
                            : null
                        }
                      />
                    </Td>
                    <Td className="font-mono text-content-muted">
                      {level.lastMovementAt ? (
                        new Date(level.lastMovementAt).toLocaleString()
                      ) : (
                        <span className="italic text-unknown">Never</span>
                      )}
                    </Td>
                    <Td variant="actions">
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
