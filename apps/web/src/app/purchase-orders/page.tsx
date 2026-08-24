'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import { formatMoney } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  TableToolbar,
  Td,
  Th,
  Tr,
} from '@/components/ui';
import { statusLabel, statusTone, type PurchaseOrderStatus } from './status-tone';

type ListResult = Awaited<ReturnType<typeof trpc.purchaseOrders.list.query>>;
type PurchaseOrderRow = ListResult['orders'][number];
type Supplier = Awaited<ReturnType<typeof trpc.suppliers.list.query>>[number];

const STATUS_FILTERS: PurchaseOrderStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SENT',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'CANCELLED',
];

/**
 * The purchasing front door: every PO for the selected store, newest first, filterable by status
 * and supplier, with the lifecycle's other entry points (new PO, walk-in receipt, suggestions,
 * variance queue) one click away. Pagination is keyset ("Load more" carries the last row's id as
 * the cursor) — a page can never skip or double-show a PO because new ones landed while reading.
 *
 * A PO whose total shows "No lines yet" genuinely has zero lines — that is a fact about a draft,
 * deliberately not rendered as 0.00: a zero total on an unpriced draft reads as a real amount.
 */
export default function PurchaseOrdersPage() {
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const [orders, setOrders] = useState<PurchaseOrderRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [supplierFilter, setSupplierFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    trpc.suppliers.list.query().then(setSuppliers).catch(() => {
      // The filter dropdown simply stays empty — the list itself still loads.
    });
  }, []);

  const load = useCallback(
    (cursor?: string) => {
      if (!selectedStoreId) return;
      const isFirstPage = cursor === undefined;
      if (isFirstPage) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }
      trpc.purchaseOrders.list
        .query({
          storeId: selectedStoreId,
          ...(statusFilter !== '' ? { status: statusFilter as PurchaseOrderStatus } : {}),
          ...(supplierFilter !== '' ? { supplierId: supplierFilter } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        })
        .then((result) => {
          setOrders((previous) => (isFirstPage ? result.orders : [...previous, ...result.orders]));
          setNextCursor(result.nextCursor);
        })
        .catch(() => setError('Could not load purchase orders.'))
        .finally(() => {
          setLoading(false);
          setLoadingMore(false);
        });
    },
    [selectedStoreId, statusFilter, supplierFilter]
  );

  useEffect(() => {
    load();
  }, [load]);

  const hasFilters = statusFilter !== '' || supplierFilter !== '';

  return (
    <>
      <PageHeader
        title="Purchase orders"
        description="Every order, from draft to received."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {stores.length > 1 && (
              <Select
                value={selectedStoreId ?? ''}
                onChange={(e) => setSelectedStoreId(e.target.value)}
                aria-label="Store"
                className="w-auto"
              >
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </Select>
            )}
            <Link href="/purchase-orders/suggestions">
              <Button>Suggestions</Button>
            </Link>
            <Link href="/purchase-orders/variance-queue">
              <Button>Variance queue</Button>
            </Link>
            <Link href="/purchase-orders/receive-walk-in">
              <Button>Receive walk-in</Button>
            </Link>
            <Link href="/purchase-orders/new">
              <Button variant="primary">New PO</Button>
            </Link>
          </div>
        }
      />

      {error && <ErrorNotice action={<Button onClick={() => load()}>Retry</Button>}>{error}</ErrorNotice>}

      <Card>
        <TableToolbar>
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter by status"
            className="w-auto"
          >
            <option value="">All statuses</option>
            {STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {statusLabel(status)}
              </option>
            ))}
          </Select>
          <Select
            value={supplierFilter}
            onChange={(e) => setSupplierFilter(e.target.value)}
            aria-label="Filter by supplier"
            className="w-auto"
          >
            <option value="">All suppliers</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </Select>
        </TableToolbar>

        {(loading || storesLoading) && <SkeletonRows columns={5} />}
        {!storesLoading && !loading && stores.length === 0 && (
          <EmptyState
            title="No stores available."
            hint="Every workspace gets a store when it's created, so this usually means your account isn't linked to one yet. Contact your workspace owner if this doesn't resolve after signing out and back in."
          />
        )}
        {!loading && !error && stores.length > 0 && orders.length === 0 && (
          <EmptyState
            variant={hasFilters ? 'no-matches' : 'no-data'}
            title={hasFilters ? 'No purchase orders match these filters' : 'No purchase orders yet'}
            hint={
              hasFilters
                ? 'Try clearing a filter — orders in other statuses or from other suppliers are hidden.'
                : 'Create one from scratch, or start from what the reorder suggestions say you actually need.'
            }
            action={
              hasFilters ? (
                <Button
                  onClick={() => {
                    setStatusFilter('');
                    setSupplierFilter('');
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <div className="flex gap-2">
                  <Link href="/purchase-orders/suggestions">
                    <Button>View suggestions</Button>
                  </Link>
                  <Link href="/purchase-orders/new">
                    <Button variant="primary">New PO</Button>
                  </Link>
                </div>
              )
            }
          />
        )}
        {!loading && !error && orders.length > 0 && (
          <>
            <Table aria-label="Purchase orders">
              <thead>
                <tr>
                  <Th>PO number</Th>
                  <Th>Supplier</Th>
                  <Th>Status</Th>
                  <Th align="right">Total</Th>
                  <Th>Created</Th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <Tr key={order.id}>
                    <Td className="font-medium">
                      <Link href={`/purchase-orders/${order.id}`} className="text-accent hover:underline">
                        {order.poNumber}
                      </Link>
                    </Td>
                    <Td>{order.supplierName ?? <span className="text-content-subtle">—</span>}</Td>
                    <Td>
                      <Badge tone={statusTone(order.status)}>{statusLabel(order.status)}</Badge>
                    </Td>
                    <Td variant="numeric">
                      {order.total !== null ? (
                        formatMoney(order.total, order.currency)
                      ) : (
                        <span className="text-sm text-content-subtle italic">No lines yet</span>
                      )}
                    </Td>
                    <Td className="font-mono text-content-muted">
                      {new Date(order.createdAt).toLocaleDateString()}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            {nextCursor !== null && (
              <div className="flex justify-center border-t border-border px-5 py-3">
                <Button disabled={loadingMore} onClick={() => load(nextCursor)}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
