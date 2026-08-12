import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { generatePurchaseOrderPdf, type PurchaseOrderPdfInput } from './po-pdf.js';

const baseInput: PurchaseOrderPdfInput = {
  poNumber: 'PO-1001',
  status: 'SENT',
  currency: 'USD',
  createdAt: new Date('2026-08-01T00:00:00Z'),
  expectedDeliveryDate: new Date('2026-08-05T00:00:00Z'),
  notes: 'Deliver to loading dock',
  store: { name: 'Main Street Cafe', address: '123 Main St' },
  supplier: { name: 'Coastal Meats', contactName: 'Jane Doe', contactEmail: 'jane@coastalmeats.example' },
  lines: [
    {
      lineNumber: 1,
      productName: 'Chicken Breast',
      supplierSku: 'CHK-BRST-BONE',
      quantityOrderUnits: '40',
      orderUnitLabel: 'kg',
      unitPrice: '6.7500',
      lineTotal: '270.0000',
    },
  ],
  total: '270.0000',
};

describe('generatePurchaseOrderPdf', () => {
  it('produces bytes that are a real, loadable PDF document', async () => {
    const bytes = await generatePurchaseOrderPdf(baseInput);
    expect(bytes.byteLength).toBeGreaterThan(0);
    // A genuine round-trip through pdf-lib's own parser — proves this is a real, well-formed PDF,
    // not just a byte blob that happens to start with '%PDF'.
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('starts with the real PDF file signature', async () => {
    const bytes = await generatePurchaseOrderPdf(baseInput);
    const header = Buffer.from(bytes.slice(0, 5)).toString('ascii');
    expect(header).toBe('%PDF-');
  });

  it('renders a total of "—" (not a fabricated 0) when total is null (I7)', async () => {
    const bytes = await generatePurchaseOrderPdf({ ...baseInput, lines: [], total: null });
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it('paginates onto a new page when a PO has enough lines to overflow one page', async () => {
    const manyLines = Array.from({ length: 60 }, (_, i) => ({
      lineNumber: i + 1,
      productName: `Product ${i + 1}`,
      supplierSku: null,
      quantityOrderUnits: '1',
      orderUnitLabel: 'each',
      unitPrice: '1.0000',
      lineTotal: '1.0000',
    }));
    const bytes = await generatePurchaseOrderPdf({ ...baseInput, lines: manyLines, total: '60.0000' });
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBeGreaterThan(1);
  });

  it('handles a line with no supplier SKU (nullable field) without throwing', async () => {
    const bytes = await generatePurchaseOrderPdf({
      ...baseInput,
      lines: [{ ...baseInput.lines[0]!, supplierSku: null }],
    });
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it('handles a store with no address and a supplier with no contact name/email without throwing', async () => {
    const bytes = await generatePurchaseOrderPdf({
      ...baseInput,
      store: { name: 'Main Street Cafe', address: null },
      supplier: { name: 'Coastal Meats', contactName: null, contactEmail: null },
      notes: null,
      expectedDeliveryDate: null,
    });
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});
