/**
 * A minimal, real, single-page PDF per GST tax invoice — with a DIFFERENT LAYOUT PER SUPPLIER.
 *
 * Hand-built rather than pdf-lib: the output must be byte-deterministic (pdf-lib embeds a creation
 * timestamp), and the review screen only needs a valid document its presigned download can open.
 *
 * Why four layouts rather than one template: real suppliers do not share stationery. A Chickpet
 * wholesaler's boxed docket, a dairy distributor's clean letterhead, a mandi's terse weight-led slip
 * and a corporate packaging firm's tax-summary block look nothing alike. Extraction that only ever
 * sees one layout is not being exercised against reality — layout variation is precisely what makes
 * document parsing hard.
 *
 * ASCII/latin1 ONLY. The base font is Courier, a Type1 font with no Devanagari or Kannada glyphs;
 * non-latin1 characters would be written as mangled bytes into the very document that acts as the
 * provenance record behind a cost figure. `toLatin1` enforces this rather than trusting upstream
 * data to be clean — the rupee sign itself (U+20B9) is outside latin1, so amounts are labelled
 * `INR` in text instead.
 */
import { toDisplay2dp } from './money.mts';
import type { InvoiceLayout } from './suppliers.mts';

interface PdfInvoiceLine { sku: string; supplierSku: string; description: string; hsn: string; qty: string; unitPrice: string; lineTotal: string; gstBasisPoints: number }
interface PdfInvoice {
  number: string; supplierName: string; gstin: string; supplierAddress: string;
  date: string; lines: PdfInvoiceLine[];
  subtotal: string; cgst: string; sgst: string; total: string;
}
interface Buyer { legalName: string; tradeName: string; gstin: string; address: string; state: string; stateCode: string }

/** Replaces anything outside printable latin1 rather than emitting bytes Courier cannot render. */
const toLatin1 = (s: string): string => s.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

const escape = (s: string): string =>
  toLatin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Courier is monospaced, so character counts align columns exactly. */
const pad = (s: string, w: number): string => (s.length >= w ? s.slice(0, w) : s.padEnd(w));
const padL = (s: string, w: number): string => (s.length >= w ? s.slice(0, w) : s.padStart(w));
const centre = (s: string, w: number): string => {
  if (s.length >= w) return s.slice(0, w);
  const left = Math.floor((w - s.length) / 2);
  return ' '.repeat(left) + s + ' '.repeat(w - s.length - left);
};

const W = 92;

/** Indian numbering for the "amount in words" line a wholesaler invoice traditionally carries. */
const amountInWords = (value4dp: string): string => {
  const whole = Number(toDisplay2dp(value4dp).split('.')[0] ?? '0');
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const under100 = (n: number): string =>
    n < 20 ? ones[n]! : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ''}`;
  const under1000 = (n: number): string =>
    n < 100 ? under100(n) : `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${under100(n % 100)}` : ''}`;
  if (whole === 0) return 'Zero Rupees Only';
  const parts: string[] = [];
  const lakh = Math.floor(whole / 100000);
  const thousand = Math.floor((whole % 100000) / 1000);
  const rest = whole % 1000;
  if (lakh) parts.push(`${under1000(lakh)} Lakh`);
  if (thousand) parts.push(`${under1000(thousand)} Thousand`);
  if (rest) parts.push(under1000(rest));
  return `${parts.join(' ')} Rupees Only`;
};

const taxSummary = (invoice: PdfInvoice): { rate: string; taxable: string; cgst: string; sgst: string }[] => {
  const byRate = new Map<number, string[]>();
  for (const line of invoice.lines) {
    byRate.set(line.gstBasisPoints, [...(byRate.get(line.gstBasisPoints) ?? []), line.lineTotal]);
  }
  return [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bps, totals]) => {
      const scaled = totals.reduce((sum, v) => {
        const [i = '0', f = ''] = v.split('.');
        return sum + BigInt(i + f.padEnd(4, '0').slice(0, 4));
      }, 0n);
      const taxable = `${scaled.toString().padStart(5, '0').slice(0, -4)}.${scaled.toString().padStart(5, '0').slice(-4)}`;
      const half = (scaled * BigInt(bps / 2)) / 10000n;
      const halfStr = `${half.toString().padStart(5, '0').slice(0, -4)}.${half.toString().padStart(5, '0').slice(-4)}`;
      return { rate: `${(bps / 100).toFixed(1)}%`, taxable, cgst: halfStr, sgst: halfStr };
    });
};

const layoutWholesaler = (inv: PdfInvoice, buyer: Buyer): string[] => [
  `+${'='.repeat(W - 2)}+`,
  `|${centre('|| Shree Ganeshaya Namaha ||', W - 2)}|`,
  `|${centre(inv.supplierName.toUpperCase(), W - 2)}|`,
  `|${centre(inv.supplierAddress, W - 2)}|`,
  `|${centre(`GSTIN: ${inv.gstin}   State: ${buyer.state} (${buyer.stateCode})`, W - 2)}|`,
  `+${'='.repeat(W - 2)}+`,
  centre('TAX INVOICE', W),
  '',
  `Invoice No : ${pad(inv.number, 28)}Dated : ${inv.date}`,
  `Terms      : Credit`,
  '',
  `M/s ${buyer.legalName}`,
  `    ${buyer.address}`,
  `    GSTIN: ${buyer.gstin}`,
  '-'.repeat(W),
  `${pad('Sl', 4)}${pad('Particulars', 40)}${pad('HSN', 7)}${padL('Qty', 5)}${padL('Rate', 15)}${padL('Amount', 21)}`,
  '-'.repeat(W),
  ...inv.lines.map((l, i) =>
    `${pad(String(i + 1), 4)}${pad(l.description, 40)}${pad(l.hsn, 7)}${padL(l.qty, 5)}${padL(toDisplay2dp(l.unitPrice), 15)}${padL(toDisplay2dp(l.lineTotal), 21)}`
  ),
  '-'.repeat(W),
  `${padL('Taxable Value :', 71)}${padL(toDisplay2dp(inv.subtotal), 21)}`,
  `${padL('Add: CGST :', 71)}${padL(toDisplay2dp(inv.cgst), 21)}`,
  `${padL('Add: SGST :', 71)}${padL(toDisplay2dp(inv.sgst), 21)}`,
  `${padL('GRAND TOTAL :', 71)}${padL(toDisplay2dp(inv.total), 21)}`,
  '-'.repeat(W),
  `Amount in words: ${amountInWords(inv.total)}`,
  '',
  'Goods once sold will not be taken back. E.& O.E.',
  `${padL(`for ${inv.supplierName}`, W)}`,
  `${padL('Authorised Signatory', W)}`,
];

const layoutDistributor = (inv: PdfInvoice, buyer: Buyer): string[] => [
  inv.supplierName,
  inv.supplierAddress,
  `GSTIN ${inv.gstin}`,
  '',
  '='.repeat(W),
  `TAX INVOICE${' '.repeat(20)}${inv.number}${' '.repeat(8)}${inv.date}`,
  '='.repeat(W),
  '',
  `Billed to   ${buyer.legalName}`,
  `            ${buyer.address}`,
  `            GSTIN ${buyer.gstin}`,
  `Supply      Intra-state (${buyer.state})`,
  '',
  `${pad('CODE', 18)}${pad('ITEM', 32)}${pad('HSN', 7)}${padL('QTY', 5)}${padL('RATE', 14)}${padL('VALUE', 16)}`,
  '-'.repeat(W),
  ...inv.lines.map((l) =>
    `${pad(l.supplierSku, 18)}${pad(l.description, 32)}${pad(l.hsn, 7)}${padL(l.qty, 5)}${padL(toDisplay2dp(l.unitPrice), 14)}${padL(toDisplay2dp(l.lineTotal), 16)}`
  ),
  '-'.repeat(W),
  `${padL('Sub total', 76)}${padL(toDisplay2dp(inv.subtotal), 16)}`,
  `${padL('CGST', 76)}${padL(toDisplay2dp(inv.cgst), 16)}`,
  `${padL('SGST', 76)}${padL(toDisplay2dp(inv.sgst), 16)}`,
  `${padL('TOTAL PAYABLE (INR)', 76)}${padL(toDisplay2dp(inv.total), 16)}`,
  '',
  'Payment due as per agreed credit terms. Please quote the invoice number on remittance.',
];

const layoutMandi = (inv: PdfInvoice, buyer: Buyer): string[] => [
  `${inv.supplierName}  |  GSTIN ${inv.gstin}`,
  inv.supplierAddress,
  '',
  `DELIVERY CHALLAN CUM TAX INVOICE   No ${inv.number}   Dt ${inv.date}`,
  `To: ${buyer.tradeName}, ${buyer.address}`,
  `    GSTIN ${buyer.gstin}`,
  '',
  `${pad('ITEM', 38)}${pad('HSN', 7)}${padL('QTY', 6)}${padL('RATE', 13)}${padL('AMOUNT', 16)}`,
  '.'.repeat(W),
  ...inv.lines.map((l) =>
    `${pad(l.description, 38)}${pad(l.hsn, 7)}${padL(l.qty, 6)}${padL(toDisplay2dp(l.unitPrice), 13)}${padL(toDisplay2dp(l.lineTotal), 16)}`
  ),
  '.'.repeat(W),
  `${padL('Value', 76)}${padL(toDisplay2dp(inv.subtotal), 16)}`,
  `${padL('CGST + SGST', 76)}${padL(toDisplay2dp(inv.cgst), 8)}${padL(toDisplay2dp(inv.sgst), 8)}`,
  `${padL('NET (INR)', 76)}${padL(toDisplay2dp(inv.total), 16)}`,
  '',
  'Perishable goods. Please verify weight and condition at the time of delivery.',
  'Received in good order:  ______________________',
];

const layoutCorporate = (inv: PdfInvoice, buyer: Buyer): string[] => {
  const summary = taxSummary(inv);
  return [
    `${pad(inv.supplierName.toUpperCase(), 54)}${padL('TAX INVOICE', W - 54)}`,
    `${pad(inv.supplierAddress, 54)}${padL(`No. ${inv.number}`, W - 54)}`,
    `${pad(`GSTIN: ${inv.gstin}`, 54)}${padL(`Date: ${inv.date}`, W - 54)}`,
    '_'.repeat(W),
    '',
    'BILL TO',
    `  ${buyer.legalName}`,
    `  ${buyer.address}`,
    `  GSTIN: ${buyer.gstin}   Place of supply: ${buyer.state} (${buyer.stateCode})`,
    '',
    `${pad('#', 4)}${pad('DESCRIPTION OF GOODS', 36)}${pad('HSN/SAC', 9)}${padL('QTY', 5)}${padL('UNIT RATE', 15)}${padL('TAXABLE VALUE', 23)}`,
    '_'.repeat(W),
    ...inv.lines.map((l, i) =>
      `${pad(String(i + 1), 4)}${pad(l.description, 36)}${pad(l.hsn, 9)}${padL(l.qty, 5)}${padL(toDisplay2dp(l.unitPrice), 15)}${padL(toDisplay2dp(l.lineTotal), 23)}`
    ),
    '_'.repeat(W),
    '',
    'TAX SUMMARY',
    `${pad('  RATE', 12)}${padL('TAXABLE', 18)}${padL('CGST', 16)}${padL('SGST', 16)}`,
    ...summary.map((s) =>
      `${pad(`  ${s.rate}`, 12)}${padL(toDisplay2dp(s.taxable), 18)}${padL(toDisplay2dp(s.cgst), 16)}${padL(toDisplay2dp(s.sgst), 16)}`
    ),
    '',
    `${padL('TOTAL TAXABLE VALUE', 68)}${padL(toDisplay2dp(inv.subtotal), 24)}`,
    `${padL('TOTAL TAX', 68)}${padL(toDisplay2dp(inv.cgst), 12)}${padL(toDisplay2dp(inv.sgst), 12)}`,
    `${padL('INVOICE TOTAL (INR)', 68)}${padL(toDisplay2dp(inv.total), 24)}`,
    '_'.repeat(W),
    'Remittance: NEFT/RTGS as per agreed terms. Interest applies on overdue balances.',
    'This is a computer-generated invoice and does not require a signature.',
  ];
};

const LAYOUTS: Record<InvoiceLayout, (inv: PdfInvoice, buyer: Buyer) => string[]> = {
  wholesaler: layoutWholesaler,
  distributor: layoutDistributor,
  mandi: layoutMandi,
  corporate: layoutCorporate,
};

export const buildInvoicePdf = (invoice: PdfInvoice, buyer: Buyer, layout: InvoiceLayout): Buffer => {
  const textLines = LAYOUTS[layout](invoice, buyer);

  // 8pt Courier at 11pt leading fits the widest row (92 chars) inside A4 with margins.
  const content = ['BT /F1 8 Tf 28 812 Td 11 TL', ...textLines.map((l) => `(${escape(l)}) Tj T*`), 'ET'].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) body += `${String(at).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;

  return Buffer.from(body, 'latin1');
};
