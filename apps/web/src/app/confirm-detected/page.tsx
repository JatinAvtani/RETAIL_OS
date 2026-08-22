'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import {
  Badge,
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
} from '@/components/ui';

type ProductCandidate = Awaited<ReturnType<typeof trpc.productDetection.detectProducts.query>>[number];
type SupplierCandidate = Awaited<ReturnType<typeof trpc.productDetection.detectSuppliers.query>>[number];

const UNIT_OPTIONS = ['kg', 'g', 'l', 'ml', 'mg', 'each'] as const;

/**
 * 012-05: the bulk-confirm screen plan.md calls "where onboarding is won or lost." Detection
 * (012-03/012-04) only ever proposes — every field here is editable before confirming, and
 * confirming is the ONLY place this epic writes a real product/supplier (I9). Suppliers confirm
 * first, in one click each (no editable fields exist to confirm — see the honest scope-narrowing
 * note in supplier-detection.ts), since a product's evidence lines can only resolve to a real
 * supplier mapping once that supplier is a real row (confirmProduct reports an unconfirmed
 * supplier as a real, visible skippedLines reason, never a silent drop — I7).
 */
export default function ConfirmDetectedPage() {
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const [productCandidates, setProductCandidates] = useState<ProductCandidate[]>([]);
  const [supplierCandidates, setSupplierCandidates] = useState<SupplierCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [confirmedSupplierNames, setConfirmedSupplierNames] = useState<Set<string>>(new Set());
  const [confirmingSupplierKey, setConfirmingSupplierKey] = useState<string | null>(null);

  const [selectedProductKeys, setSelectedProductKeys] = useState<Set<string>>(new Set());
  const [productEdits, setProductEdits] = useState<Record<string, { sku: string; name: string; unit: string }>>({});
  const [confirmingProducts, setConfirmingProducts] = useState(false);
  const [confirmResults, setConfirmResults] = useState<Record<string, { confirmedMappingCount: number; skippedLines: Array<{ reason: string }> }>>({});

  const load = () => {
    if (!selectedStoreId) return;
    setLoading(true);
    setError(null);
    Promise.all([
      trpc.productDetection.detectProducts.query({ storeId: selectedStoreId }),
      trpc.productDetection.detectSuppliers.query({ storeId: selectedStoreId }),
    ])
      .then(([products, suppliers]) => {
        setProductCandidates(products);
        setSupplierCandidates(suppliers);
        setProductEdits((current) => {
          const next = { ...current };
          for (const candidate of products) {
            if (!next[candidate.clusterKey]) {
              next[candidate.clusterKey] = {
                sku: '',
                name: candidate.proposedName,
                unit: candidate.proposedUnit ?? 'each',
              };
            }
          }
          return next;
        });
      })
      .catch(() => setError('Could not load detected candidates.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [selectedStoreId]);

  const confirmSupplier = async (candidate: SupplierCandidate) => {
    if (!selectedStoreId) return;
    setConfirmingSupplierKey(candidate.clusterKey);
    try {
      await trpc.productDetection.confirmSupplier.mutate({ storeId: selectedStoreId, name: candidate.proposedName });
      setConfirmedSupplierNames((current) => new Set(current).add(candidate.proposedName));
    } catch {
      setError(`Could not confirm supplier "${candidate.proposedName}".`);
    } finally {
      setConfirmingSupplierKey(null);
    }
  };

  const toggleProduct = (clusterKey: string) => {
    setSelectedProductKeys((current) => {
      const next = new Set(current);
      if (next.has(clusterKey)) next.delete(clusterKey);
      else next.add(clusterKey);
      return next;
    });
  };

  const selectAllHighConfidence = () => {
    // "High confidence" here means real, mechanical evidence — 2+ real invoice lines already
    // agreeing (I7: never a fabricated confidence score, only what the detector already proved).
    const highConfidence = productCandidates.filter((c) => c.evidenceLines.length >= 2 && productEdits[c.clusterKey]?.sku);
    setSelectedProductKeys(new Set(highConfidence.map((c) => c.clusterKey)));
  };

  const confirmSelectedProducts = async () => {
    if (!selectedStoreId) return;
    setConfirmingProducts(true);
    const results: typeof confirmResults = {};
    for (const clusterKey of selectedProductKeys) {
      const candidate = productCandidates.find((c) => c.clusterKey === clusterKey);
      const edit = productEdits[clusterKey];
      if (!candidate || !edit || !edit.sku.trim()) continue;
      try {
        const result = await trpc.productDetection.confirmProduct.mutate({
          storeId: selectedStoreId,
          sku: edit.sku.trim(),
          name: edit.name.trim(),
          baseUnitCode: edit.unit as (typeof UNIT_OPTIONS)[number],
          evidenceLines: candidate.evidenceLines.map((line) => ({ documentId: line.documentId, lineIndex: line.lineIndex })),
          ...(candidate.proposedPackSize ? { packSize: candidate.proposedPackSize } : {}),
        });
        results[clusterKey] = result;
      } catch {
        results[clusterKey] = { confirmedMappingCount: 0, skippedLines: [{ reason: 'Confirmation failed.' }] };
      }
    }
    setConfirmResults((current) => ({ ...current, ...results }));
    setSelectedProductKeys(new Set());
    setConfirmingProducts(false);
    load();
  };

  const remainingProductCandidates = useMemo(
    () => productCandidates.filter((c) => !confirmResults[c.clusterKey]),
    [productCandidates, confirmResults]
  );

  return (
    <>
      <PageHeader
        title="Confirm detected products & suppliers"
        description="Every field is editable before confirming — confirming writes a real, permanent mapping so later invoices from the same supplier need no review."
        actions={
          !storesLoading && stores.length > 0 ? (
            <Select value={selectedStoreId} onChange={(e) => setSelectedStoreId(e.target.value)} className="w-auto">
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </Select>
          ) : undefined
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      {(loading || storesLoading) && <LoadingState label="Scanning your invoices…" />}

      {!loading && !storesLoading && (
        <>
          <Card className="mb-6">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-base font-semibold text-content">Suppliers</h2>
              <span className="text-xs text-content-subtle">Confirm each individually — no fields to edit.</span>
            </div>
            {supplierCandidates.length === 0 ? (
              <div className="p-5">
                <EmptyState title="No new suppliers detected" hint="Approve a supplier invoice first." />
              </div>
            ) : (
              <Table aria-label="Detected suppliers">
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th align="right">Evidence</Th>
                    <Th align="right"></Th>
                  </tr>
                </thead>
                <tbody>
                  {supplierCandidates.map((candidate) => {
                    const confirmed = confirmedSupplierNames.has(candidate.proposedName);
                    return (
                      <Tr key={candidate.clusterKey}>
                        <Td>{candidate.proposedName}</Td>
                        <Td align="right">
                          <Badge tone="accent">{candidate.evidenceDocumentIds.length} invoice{candidate.evidenceDocumentIds.length === 1 ? '' : 's'}</Badge>
                        </Td>
                        <Td variant="actions">
                          {confirmed ? (
                            <Badge tone="positive">Confirmed</Badge>
                          ) : (
                            <Button
                              variant="secondary"
                              onClick={() => confirmSupplier(candidate)}
                              disabled={confirmingSupplierKey === candidate.clusterKey}
                            >
                              {confirmingSupplierKey === candidate.clusterKey ? 'Confirming…' : 'Confirm'}
                            </Button>
                          )}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-base font-semibold text-content">Products</h2>
              {remainingProductCandidates.length > 0 && (
                <Button variant="secondary" onClick={selectAllHighConfidence}>
                  Select all high-confidence
                </Button>
              )}
            </div>
            {remainingProductCandidates.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title={productCandidates.length > 0 ? 'All detected products confirmed' : 'No new products detected'}
                  {...(productCandidates.length === 0 ? { hint: 'Approve a supplier invoice first.' } : {})}
                />
              </div>
            ) : (
              <Table aria-label="Detected products">
                <thead>
                  <tr>
                    <Th></Th>
                    <Th>SKU</Th>
                    <Th>Name</Th>
                    <Th>Unit</Th>
                    <Th align="right">Evidence</Th>
                  </tr>
                </thead>
                <tbody>
                  {remainingProductCandidates.map((candidate) => {
                    const edit = productEdits[candidate.clusterKey] ?? { sku: '', name: candidate.proposedName, unit: 'each' };
                    const selected = selectedProductKeys.has(candidate.clusterKey);
                    return (
                      <Tr key={candidate.clusterKey} selected={selected}>
                        <Td>
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleProduct(candidate.clusterKey)}
                            aria-label={`Select ${candidate.proposedName}`}
                          />
                        </Td>
                        <Td>
                          <input
                            value={edit.sku}
                            onChange={(e) =>
                              setProductEdits((current) => ({ ...current, [candidate.clusterKey]: { ...edit, sku: e.target.value } }))
                            }
                            placeholder="Required — e.g. FLR-25"
                            className="w-32 rounded-control border border-border-strong bg-surface-raised px-2 py-1 text-sm"
                          />
                        </Td>
                        <Td>
                          <input
                            value={edit.name}
                            onChange={(e) =>
                              setProductEdits((current) => ({ ...current, [candidate.clusterKey]: { ...edit, name: e.target.value } }))
                            }
                            className="w-48 rounded-control border border-border-strong bg-surface-raised px-2 py-1 text-sm"
                          />
                        </Td>
                        <Td>
                          <select
                            value={edit.unit}
                            onChange={(e) =>
                              setProductEdits((current) => ({ ...current, [candidate.clusterKey]: { ...edit, unit: e.target.value } }))
                            }
                            className="rounded-control border border-border-strong bg-surface-raised px-2 py-1 text-sm"
                          >
                            {UNIT_OPTIONS.map((unit) => (
                              <option key={unit} value={unit}>
                                {unit}
                              </option>
                            ))}
                          </select>
                        </Td>
                        <Td align="right">
                          <Badge tone="accent">{candidate.evidenceLines.length} line{candidate.evidenceLines.length === 1 ? '' : 's'}</Badge>
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
            {remainingProductCandidates.length > 0 && (
              <div className="flex items-center justify-between border-t border-border px-5 py-3">
                <span className="text-sm text-content-muted">{selectedProductKeys.size} selected</span>
                <Button
                  variant="primary"
                  onClick={confirmSelectedProducts}
                  disabled={confirmingProducts || selectedProductKeys.size === 0}
                >
                  {confirmingProducts ? 'Confirming…' : `Confirm ${selectedProductKeys.size || ''} product${selectedProductKeys.size === 1 ? '' : 's'}`}
                </Button>
              </div>
            )}
          </Card>

          {Object.keys(confirmResults).length > 0 && (
            <Card className="mt-6 p-5">
              <h2 className="mb-2 text-sm font-semibold text-content">Confirmed this session</h2>
              <ul className="space-y-1 text-sm text-content-muted">
                {Object.entries(confirmResults).map(([key, result]) => (
                  <li key={key}>
                    {result.confirmedMappingCount} mapping{result.confirmedMappingCount === 1 ? '' : 's'} confirmed
                    {result.skippedLines.length > 0 && (
                      <span className="text-warning"> — {result.skippedLines.length} line(s) skipped: {result.skippedLines[0]?.reason}</span>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className="mt-6">
            <Link href="/onboarding" className="text-sm font-medium text-accent hover:underline">
              Back to setup
            </Link>
          </div>
        </>
      )}
    </>
  );
}
