'use client';

import { useCallback, useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import {
  Badge,
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
} from '@/components/ui';

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
  /** Which menu item the human has selected per row — defaults to the top suggestion, but the
   *  selection is always explicit state, never read back out of the DOM at submit time. */
  const [choices, setChoices] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    if (!selectedStoreId) return;
    setLoading(true);
    setError(null);
    trpc.posItems.listUnmapped
      .query({ storeId: selectedStoreId })
      .then((result) => {
        setItems(result);
        setChoices(
          Object.fromEntries(
            result
              .filter((item) => item.suggestions.length > 0)
              .map((item) => [item.id, item.suggestions[0]!.menuItemId])
          )
        );
      })
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
    <>
      <PageHeader
        title="Map POS items"
        description="POS items not yet linked to a menu item, biggest sellers first. You confirm every match."
        actions={
          !storesLoading && stores.length > 0 ? (
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
          ) : null
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <Card>
        {(loading || storesLoading) && <SkeletonRows columns={4} />}
        {!storesLoading && stores.length === 0 && <EmptyState title="No stores available." />}
        {!loading && !error && stores.length > 0 && items.length === 0 && (
          <EmptyState
            title="Everything's mapped"
            hint="Every item at this store has been checked."
          />
        )}
        {!loading && !error && items.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>POS item</Th>
                <Th align="right">Revenue</Th>
                <Th>Suggested menu item</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const isPending = pendingItemId === item.id;
                const topScore = item.suggestions[0]?.score;
                return (
                  <Tr key={item.id}>
                    <Td className="font-medium">{item.name}</Td>
                    <Td variant="numeric" className="text-content-muted">
                      {item.totalRevenue === '0' ? (
                        <span className="text-content-subtle">—</span>
                      ) : (
                        item.totalRevenue
                      )}
                    </Td>
                    <Td>
                      {item.suggestions.length === 0 ? (
                        <span className="text-sm text-content-subtle italic">No close match</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Select
                            value={choices[item.id] ?? item.suggestions[0]!.menuItemId}
                            onChange={(e) =>
                              setChoices((prev) => ({ ...prev, [item.id]: e.target.value }))
                            }
                            disabled={isPending}
                            className="w-auto min-w-44"
                          >
                            {item.suggestions.map((suggestion) => (
                              <option key={suggestion.menuItemId} value={suggestion.menuItemId}>
                                {suggestion.name}
                              </option>
                            ))}
                          </Select>
                          {topScore !== undefined && (
                            <Badge tone={topScore >= 0.9 ? 'positive' : 'warning'}>
                              {Math.round(topScore * 100)}%
                            </Badge>
                          )}
                        </div>
                      )}
                    </Td>
                    <Td align="right">
                      <div className="flex justify-end gap-2">
                        {item.suggestions.length > 0 && (
                          <Button
                            type="button"
                            variant="primary"
                            disabled={isPending}
                            onClick={() => {
                              const menuItemId = choices[item.id] ?? item.suggestions[0]!.menuItemId;
                              void handleMap(item.id, menuItemId);
                            }}
                          >
                            Confirm
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={isPending}
                          onClick={() => void handleIgnore(item.id)}
                        >
                          Not a menu item
                        </Button>
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
