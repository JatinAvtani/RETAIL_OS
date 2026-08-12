'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import { Button, Card, ErrorNotice, Field, Input, PageHeader, Select, Table, Td, Th, Tr } from '@/components/ui';

type Product = Awaited<ReturnType<typeof trpc.products.list.query>>[number];
type Supplier = Awaited<ReturnType<typeof trpc.suppliers.list.query>>[number];

const DISCREPANCY_CODES = ['SHORT', 'OVER', 'DAMAGED', 'WRONG_ITEM', 'LATE'] as const;

type DraftLine = {
  key: string;
  productId: string;
  productName: string;
  quantity: string;
  unitCost: string;
  lotNumber: string;
  expiryDate: string;
  discrepancyCode: (typeof DISCREPANCY_CODES)[number] | '';
};

/**
 * 008-09 (plan.md Phase 3, spec 05 §5.2.3): "receiving without a PO is supported (walk-in/emergency
 * purchases) and creates a standalone receipt that an invoice can later match against." Confirmed
 * with the user: any product can be picked here, with a manual unit cost entered per line — no
 * confirmed supplier-product mapping is required (unlike `/purchase-orders/new`'s PO-line picker),
 * since the whole point of this screen is the unplanned case a real supplier/SKU mapping doesn't
 * exist for yet. `GoodsReceiptRepository.confirmReceipt` already supports this shape (no
 * `purchaseOrderId`, each line supplying `productId`/`unitCost` directly instead of inheriting from
 * a PO line) — this page is the first real caller that exercises it with `purchaseOrderId` genuinely
 * omitted.
 */
export default function ReceiveWalkInPage() {
  const router = useRouter();
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitCost, setUnitCost] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [discrepancyCode, setDiscrepancyCode] = useState<DraftLine['discrepancyCode']>('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    trpc.products.list.query().then(setProducts);
    trpc.suppliers.list.query().then(setSuppliers);
  }, []);

  const addDraftLine = () => {
    const product = products.find((p) => p.id === selectedProductId);
    if (!product || !quantity || !unitCost) return;
    setLines((current) => [
      ...current,
      {
        key: `${product.id}-${current.length}`,
        productId: product.id,
        productName: product.name,
        quantity,
        unitCost,
        lotNumber,
        expiryDate,
        discrepancyCode,
      },
    ]);
    setQuantity('1');
    setUnitCost('');
    setLotNumber('');
    setExpiryDate('');
    setDiscrepancyCode('');
  };

  const removeDraftLine = (key: string) => {
    setLines((current) => current.filter((l) => l.key !== key));
  };

  const handleSubmit = async () => {
    setError(null);
    if (!selectedStoreId || !supplierId || lines.length === 0) {
      setError('Choose a store, a supplier, and add at least one line.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await trpc.goodsReceipts.confirmReceipt.mutate({
        storeId: selectedStoreId,
        supplierId,
        receivedAt: new Date().toISOString(),
        ...(notes ? { notes } : {}),
        lines: lines.map((line, index) => ({
          productId: line.productId,
          receivedQuantityBaseUnits: line.quantity,
          unitCost: line.unitCost,
          lineNumber: index + 1,
          ...(line.lotNumber ? { lotNumber: line.lotNumber } : {}),
          ...(line.expiryDate ? { expiryDate: line.expiryDate } : {}),
          ...(line.discrepancyCode ? { discrepancyCode: line.discrepancyCode } : {}),
        })),
      });
      void result;
      router.push('/inventory/lots');
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Could not record this receipt.';
      setError(message);
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Receive a walk-in purchase"
        description="No purchase order — records a standalone receipt an invoice can later match against."
      />

      <Card className="max-w-3xl p-6">
        {error && <ErrorNotice>{error}</ErrorNotice>}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Store">
            <Select value={selectedStoreId} onChange={(e) => setSelectedStoreId(e.target.value)} disabled={storesLoading}>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Supplier">
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Select a supplier</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="mt-5">
          <Field label="Notes (optional)">
            <Input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Grocery run for missing dairy" />
          </Field>
        </div>

        <div className="mt-6 border-t border-border pt-5">
          <h3 className="mb-3 text-sm font-semibold text-content">Lines</h3>

          <div className="mb-4 grid gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto] sm:items-end">
            <Field label="Product">
              <Select value={selectedProductId} onChange={(e) => setSelectedProductId(e.target.value)}>
                <option value="">Select a product</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Quantity">
              <Input type="text" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </Field>
            <Field label="Unit cost">
              <Input type="text" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder="0.00" />
            </Field>
            <Field label="Lot number">
              <Input type="text" value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} />
            </Field>
            <Field label="Discrepancy">
              <Select value={discrepancyCode} onChange={(e) => setDiscrepancyCode(e.target.value as DraftLine['discrepancyCode'])}>
                <option value="">None</option>
                {DISCREPANCY_CODES.map((code) => (
                  <option key={code} value={code}>
                    {code.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="button" variant="ghost" onClick={addDraftLine} disabled={!selectedProductId || !quantity || !unitCost}>
              Add line
            </Button>
          </div>

          {lines.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <Th>Product</Th>
                  <Th align="right">Quantity</Th>
                  <Th align="right">Unit cost</Th>
                  <Th>Discrepancy</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <Tr key={line.key}>
                    <Td>{line.productName}</Td>
                    <Td align="right" className="tabular">
                      {line.quantity}
                    </Td>
                    <Td align="right" className="tabular">
                      {line.unitCost}
                    </Td>
                    <Td>{line.discrepancyCode || '—'}</Td>
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
        </div>

        <div className="mt-6 flex items-center gap-2 border-t border-border pt-5">
          <Button type="button" variant="primary" disabled={submitting || lines.length === 0} onClick={handleSubmit}>
            {submitting ? 'Recording…' : 'Record receipt'}
          </Button>
          <Link href="/purchase-orders/suggestions">
            <Button type="button" variant="ghost">
              Cancel
            </Button>
          </Link>
        </div>
      </Card>
    </>
  );
}
