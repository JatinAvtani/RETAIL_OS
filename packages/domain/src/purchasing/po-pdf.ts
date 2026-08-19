import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * the design: "SENT triggers PDF generation + email to the supplier contact." Deliberately a
 * pure function of already-formatted, already-fetched data (no DB/S3 access here) — matching this
 * package's discipline for every other domain module (`suggestReorder`, `computeRecipeCost`):
 * given the right inputs, compute/produce the output, fully testable without a database. The
 * caller (a repository or service in `packages/db`/`apps/api`) is responsible for fetching the PO,
 * its lines, the supplier, and the store, and formatting money/quantity into plain display strings
 * before calling this — this function does no unit conversion or rounding of its own (I5/I6 are the
 * caller's concern; this function only lays out already-correct text).
 */
export type PurchaseOrderPdfLine = {
  lineNumber: number;
  productName: string;
  supplierSku: string | null;
  quantityOrderUnits: string;
  orderUnitLabel: string;
  unitPrice: string;
  lineTotal: string;
};

export type PurchaseOrderPdfInput = {
  poNumber: string;
  status: string;
  currency: string;
  createdAt: Date;
  expectedDeliveryDate: Date | null;
  notes: string | null;
  store: {
    name: string;
    address: string | null;
  };
  supplier: {
    name: string;
    contactName: string | null;
    contactEmail: string | null;
  };
  lines: readonly PurchaseOrderPdfLine[];
  /** `null` when no lines have been priced yet (I7) — rendered as "—", never a fabricated total. */
  total: string | null;
};

const MARGIN = 50;
const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;

/**
 * Renders a single-page-per-overflow purchase order PDF. Deliberately plain layout (no logo/brand
 * assets — this project has none) using pdf-lib's built-in Helvetica, which needs no external font
 * file or network fetch, matching the "no card, no cost, no external calls" constraint the rest of
 * this project's document pipeline already lives under.
 */
export const generatePurchaseOrderPdf = async (input: PurchaseOrderPdfInput): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const newPageIfNeeded = (needed: number) => {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  };

  const drawText = (text: string, options: { size?: number; bold?: boolean; x?: number } = {}) => {
    const size = options.size ?? 10;
    page.drawText(text, {
      x: options.x ?? MARGIN,
      y,
      size,
      font: options.bold ? boldFont : font,
      color: rgb(0, 0, 0),
    });
    y -= size + 6;
  };

  drawText(`Purchase Order ${input.poNumber}`, { size: 18, bold: true });
  drawText(`Status: ${input.status}`, { size: 10 });
  y -= 10;

  drawText('From', { size: 11, bold: true });
  drawText(input.store.name);
  if (input.store.address !== null) drawText(input.store.address);
  y -= 10;

  drawText('To', { size: 11, bold: true });
  drawText(input.supplier.name);
  if (input.supplier.contactName !== null) drawText(input.supplier.contactName);
  if (input.supplier.contactEmail !== null) drawText(input.supplier.contactEmail);
  y -= 10;

  drawText(`Order date: ${input.createdAt.toISOString().slice(0, 10)}`);
  if (input.expectedDeliveryDate !== null) {
    drawText(`Expected delivery: ${input.expectedDeliveryDate.toISOString().slice(0, 10)}`);
  }
  if (input.notes !== null && input.notes.trim().length > 0) {
    drawText(`Notes: ${input.notes}`);
  }
  y -= 16;

  const columns = [
    { label: '#', x: MARGIN, width: 24 },
    { label: 'Item', x: MARGIN + 24, width: 210 },
    { label: 'Qty', x: MARGIN + 234, width: 70 },
    { label: 'Unit price', x: MARGIN + 304, width: 90 },
    { label: 'Line total', x: MARGIN + 394, width: 90 },
  ];
  newPageIfNeeded(20);
  for (const column of columns) {
    page.drawText(column.label, { x: column.x, y, size: 10, font: boldFont, color: rgb(0, 0, 0) });
  }
  y -= 8;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
  });
  y -= 14;

  for (const line of input.lines) {
    newPageIfNeeded(16);
    const itemLabel = line.supplierSku !== null ? `${line.productName} (${line.supplierSku})` : line.productName;
    const rowY = y;
    page.drawText(String(line.lineNumber), { x: columns[0]!.x, y: rowY, size: 9, font, color: rgb(0, 0, 0) });
    page.drawText(itemLabel.slice(0, 40), { x: columns[1]!.x, y: rowY, size: 9, font, color: rgb(0, 0, 0) });
    page.drawText(`${line.quantityOrderUnits} ${line.orderUnitLabel}`, { x: columns[2]!.x, y: rowY, size: 9, font, color: rgb(0, 0, 0) });
    page.drawText(`${input.currency} ${line.unitPrice}`, { x: columns[3]!.x, y: rowY, size: 9, font, color: rgb(0, 0, 0) });
    page.drawText(`${input.currency} ${line.lineTotal}`, { x: columns[4]!.x, y: rowY, size: 9, font, color: rgb(0, 0, 0) });
    y -= 16;
  }

  y -= 8;
  newPageIfNeeded(20);
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
  });
  y -= 18;
  drawText(`Total: ${input.total !== null ? `${input.currency} ${input.total}` : '—'}`, { size: 12, bold: true });

  return doc.save();
};
