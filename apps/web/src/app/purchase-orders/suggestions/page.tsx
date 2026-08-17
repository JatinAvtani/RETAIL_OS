'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import { Badge, Button, Card, EmptyState, ErrorNotice, PageHeader, SkeletonRows, Select, Table, Td, Th, Tr } from '@/components/ui';

type SupplierGroup = Awaited<ReturnType<typeof trpc.purchaseOrders.reorderSuggestions.query>>[number];

const confidenceTone = (confidence: SupplierGroup['suggestions'][number]['suggestion']['confidence']) => {
  if (confidence === 'HIGH') return 'positive' as const;
  if (confidence === 'MEDIUM') return 'warning' as const;
  return 'neutral' as const;
};

/**
 * 008-04: the first real caller of 008-02's `suggestReorder`. Grouped by supplier (spec D10 —
 * "manager orders per supplier, not per item"), each row shows the plain-language explanation
 * `plan.md` itself specifies, so a manager can verify the reasoning at a glance rather than trust
 * a bare number. "Create PO" (008-05) links to `/purchase-orders/new` with the store/supplier
 * pre-selected — a deliberate integration point between the two tasks, not two unrelated screens —
 * but adds no lines automatically; a manager still confirms every line by hand on the create page.
 */
export default function ReorderSuggestionsPage() {
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const [groups, setGroups] = useState<SupplierGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!selectedStoreId) return;
    setLoading(true);
    setError(null);
    trpc.purchaseOrders.reorderSuggestions
      .query({ storeId: selectedStoreId })
      .then(setGroups)
      .catch(() => setError('Could not load reorder suggestions.'))
      .finally(() => setLoading(false));
  }, [selectedStoreId]);

  useEffect(() => {
    load();
  }, [load]);

  const totalSuggestions = groups.reduce((sum, g) => sum + g.suggestions.length, 0);

  return (
    <>
      <PageHeader
        title="Reorder suggestions"
        description="Reorder suggestions by supplier, with the reasoning behind each one."
        actions={
          <div className="flex items-center gap-2">
            {!storesLoading && stores.length > 0 && (
              <Select value={selectedStoreId} onChange={(event) => setSelectedStoreId(event.target.value)} className="w-auto">
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </Select>
            )}
            <Link href="/purchase-orders/receive-walk-in">
              <Button type="button" variant="ghost">
                Receive walk-in purchase
              </Button>
            </Link>
          </div>
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <Card>
        {(loading || storesLoading) && <SkeletonRows columns={5} />}
        {!storesLoading && stores.length === 0 && <EmptyState title="No stores available." />}
        {!loading && !error && stores.length > 0 && totalSuggestions === 0 && (
          <EmptyState
            title="Nothing needs reordering right now"
            hint="Products show up here once they're low on stock and have enough history to work from."
          />
        )}
        {!loading &&
          !error &&
          groups.map((group) => (
            <div key={group.supplierId} className="mb-8 last:mb-0">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-content">{group.supplierName}</h3>
                <Link href={`/purchase-orders/new?storeId=${selectedStoreId}&supplierId=${group.supplierId}`}>
                  <Button type="button" variant="ghost">
                    Create PO
                  </Button>
                </Link>
              </div>
              <Table>
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <Th align="right">Suggested quantity</Th>
                    <Th>Confidence</Th>
                    <Th>Why</Th>
                  </tr>
                </thead>
                <tbody>
                  {group.suggestions.map((row) => (
                    <Tr key={row.supplierProductId}>
                      <Td className="font-medium">{row.productName}</Td>
                      <Td variant="numeric">
                        {row.suggestion.quantity.amount} {row.unit ?? ''}
                      </Td>
                      <Td>
                        <Badge tone={confidenceTone(row.suggestion.confidence)}>{row.suggestion.confidence}</Badge>
                      </Td>
                      <Td className="text-sm text-content-muted">{row.explanationText}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ))}
      </Card>
    </>
  );
}
