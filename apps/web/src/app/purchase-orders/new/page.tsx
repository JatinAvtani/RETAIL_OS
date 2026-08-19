'use client';

import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import { Button, Card, ErrorNotice, Field, Input, LoadingState, PageHeader, Select, Table, Td, Th, Tr } from '@/components/ui';
import { addDecimal, formatMoney, multiplyDecimal } from '@/lib/format';

type Supplier = Awaited<ReturnType<typeof trpc.suppliers.list.query>>[number];
type ConfirmedProduct = Awaited<ReturnType<typeof trpc.suppliers.confirmedProducts.query>>[number];

type DraftLine = {
  key: string;
  supplierProductId: string;
  productId: string;
  productName: string;
  quantityOrderUnits: string;
  unitPrice: string;
  conversionToBase: string;
};

/**
 * Create a real DRAFT purchase order, then add real lines one at a time
 * (`PurchaseOrderRepository.addLine` — DRAFT-only, server-computed line totals). Pre-fills
 * store/supplier from `/purchase-orders/suggestions`' "Create PO" link when present,
 * but never pre-fills lines automatically — every line is a real, explicit
 * `addLine` call the manager confirms by picking a quantity and price, matching I9 ("AI/suggestions
 * draft, humans approve") even though this task itself has no AI involvement at all.
 */
export default function NewPurchaseOrderPage() {
  return (
    <Suspense fallback={null}>
      <NewPurchaseOrderForm />
    </Suspense>
  );
}

/** `useSearchParams()` requires a Suspense boundary for static prerendering (Next.js 15 App Router) — split out so the default export can provide one. */
function NewPurchaseOrderForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [confirmedProducts, setConfirmedProducts] = useState<ConfirmedProduct[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [selectedSupplierProductId, setSelectedSupplierProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Gate the form until suppliers arrive — an empty supplier dropdown filling itself a beat
  // after paint reads as a broken page.
  const [suppliersLoading, setSuppliersLoading] = useState(true);

  useEffect(() => {
    trpc.suppliers.list
      .query()
      .then(setSuppliers)
      .finally(() => setSuppliersLoading(false));
  }, []);

  // Applies the /purchase-orders/suggestions "Create PO" link's pre-fill once, on mount, from the
  // real query string — intentionally not re-run on every render.
  useEffect(() => {
    const storeIdParam = searchParams.get('storeId');
    const supplierIdParam = searchParams.get('supplierId');
    if (storeIdParam) setSelectedStoreId(storeIdParam);
    if (supplierIdParam) setSupplierId(supplierIdParam);
  }, []);

  const loadConfirmedProducts = useCallback(() => {
    if (!supplierId) {
      setConfirmedProducts([]);
      return;
    }
    trpc.suppliers.confirmedProducts.query({ supplierId }).then((result) => {
      setConfirmedProducts(result);
      setSelectedSupplierProductId(result[0]?.id ?? '');
    });
  }, [supplierId]);

  useEffect(() => {
    loadConfirmedProducts();
  }, [loadConfirmedProducts]);

  const addDraftLine = () => {
    const product = confirmedProducts.find((p) => p.id === selectedSupplierProductId);
    const conversionToBase = product?.conversionToBase;
    // A confirmed mapping with no recorded conversionToBase has no reliable order-unit-to-base-unit
    // factor (I6) — refusing to add the line rather than silently assuming 1:1, which would be
    // exactly the "implicit unit conversion" failure I6 exists to prevent.
    if (!product || !quantity || !unitPrice || !conversionToBase) return;
    setLines((current) => [
      ...current,
      {
        key: `${product.id}-${current.length}`,
        supplierProductId: product.id,
        productId: product.productId,
        productName: product.productName ?? 'Unknown product',
        quantityOrderUnits: quantity,
        unitPrice,
        conversionToBase,
      },
    ]);
    setQuantity('1');
    setUnitPrice('');
  };

  const removeDraftLine = (key: string) => {
    setLines((current) => current.filter((l) => l.key !== key));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const created = await trpc.purchaseOrders.create.mutate({
        storeId: selectedStoreId,
        supplierId,
        poNumber,
      });

      for (const line of lines) {
        await trpc.purchaseOrders.addLine.mutate({
          purchaseOrderId: created.id,
          supplierProductId: line.supplierProductId,
          productId: line.productId,
          quantityOrderUnits: line.quantityOrderUnits,
          conversionToBase: line.conversionToBase,
          unitPrice: line.unitPrice,
          lineNumber: lines.indexOf(line) + 1,
        });
      }

      router.push(`/purchase-orders/${created.id}`);
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Something went wrong. Try again.';
      setError(message);
      setSubmitting(false);
    }
  };

  // Exact string-decimal preview, never float money math: the server computes the authoritative
  // total on create; this preview must agree with it to the digit or it trains distrust. A line
  // whose fields are mid-edit (invalid decimal) contributes null, and the whole preview shows
  // an em dash rather than a total that silently excludes that line.
  const total = lines.reduce<string | null>(
    (sum, l) => (sum === null ? null : addDecimal(sum, multiplyDecimal(l.quantityOrderUnits, l.unitPrice) ?? '')),
    '0'
  );

  if (storesLoading || suppliersLoading) {
    return (
      <>
        <PageHeader title="New purchase order" description="A draft — you can change it until you submit it." />
        <Card className="max-w-3xl">
          <LoadingState />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="New purchase order" description="A draft — you can change it until you submit it." />

      <Card className="max-w-3xl p-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          {error && <ErrorNotice>{error}</ErrorNotice>}

          <div className="grid gap-5 sm:grid-cols-3">
            <Field label="Store">
              <Select value={selectedStoreId} onChange={(e) => setSelectedStoreId(e.target.value)} required disabled={storesLoading}>
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Supplier">
              <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
                <option value="">Select a supplier</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="PO number">
              <Input type="text" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} required placeholder="PO-1001" />
            </Field>
          </div>

          <div className="border-t border-border pt-5">
            <h3 className="mb-3 text-sm font-semibold text-content">Lines</h3>

            {!supplierId && <p className="text-sm text-content-subtle">Choose a supplier to add lines.</p>}

            {supplierId && confirmedProducts.length === 0 && (
              <p className="text-sm text-content-subtle">
                This supplier has no confirmed product mappings yet — a line needs a real, confirmed
                supplier-product mapping to know its pack size and unit.
              </p>
            )}

            {supplierId && confirmedProducts.length > 0 && (
              <div className="mb-4 grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
                <Field label="Product">
                  <Select value={selectedSupplierProductId} onChange={(e) => setSelectedSupplierProductId(e.target.value)}>
                    {confirmedProducts.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.productName ?? product.supplierSku}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Quantity">
                  <Input type="text" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
                </Field>
                <Field label="Unit price">
                  <Input type="text" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} placeholder="0.00" />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={addDraftLine}
                  disabled={!selectedSupplierProductId || !unitPrice || !confirmedProducts.find((p) => p.id === selectedSupplierProductId)?.conversionToBase}
                >
                  Add line
                </Button>
              </div>
            )}
            {supplierId &&
              selectedSupplierProductId &&
              !confirmedProducts.find((p) => p.id === selectedSupplierProductId)?.conversionToBase && (
                <p className="mb-4 text-sm text-warning">
                  This mapping has no recorded unit-conversion factor yet — it can&apos;t be added to a PO until that&apos;s set.
                </p>
              )}

            {lines.length > 0 && (
              <Table>
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <Th align="right">Quantity</Th>
                    <Th align="right">Unit price</Th>
                    <Th align="right">Line total</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <Tr key={line.key}>
                      <Td>{line.productName}</Td>
                      <Td variant="numeric">
                        {line.quantityOrderUnits}
                      </Td>
                      <Td variant="numeric">
                        {line.unitPrice}
                      </Td>
                      <Td variant="numeric">
                        {(() => {
                          const lineTotal = multiplyDecimal(line.quantityOrderUnits, line.unitPrice);
                          return lineTotal !== null ? formatMoney(lineTotal) : <span className="text-content-subtle">—</span>;
                        })()}
                      </Td>
                      <Td align="right">
                        <Button type="button" variant="ghost" onClick={() => removeDraftLine(line.key)}>
                          Remove
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}

            {lines.length > 0 && (
              <p className="mt-3 text-right text-sm font-medium text-content">
                Total: {total !== null ? formatMoney(total) : '—'}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-border pt-5">
            <Button type="submit" variant="primary" disabled={submitting || !selectedStoreId || !supplierId || !poNumber}>
              {submitting ? 'Creating…' : 'Create draft PO'}
            </Button>
            <Link href="/purchase-orders/suggestions">
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </Link>
          </div>
        </form>
      </Card>
    </>
  );
}
