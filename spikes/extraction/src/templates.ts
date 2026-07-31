import type { InvoiceGroundTruth } from "./types.js";

function fmt(n: string): string {
  const v = Number(n);
  return v < 0 ? `(${Math.abs(v).toFixed(2)})` : v.toFixed(2);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Layout A — modern grid, sans-serif, boxed header. Used by Nova Foods, Riverside.
function layoutModernGrid(inv: InvoiceGroundTruth): string {
  const rows = inv.lines
    .map(
      (l) => `
    <tr>
      <td class="sku">${l.sku ? esc(l.sku) : "—"}</td>
      <td>${esc(l.description)}</td>
      <td class="num">${l.quantity}</td>
      <td class="num">${esc(l.unit)}</td>
      <td class="num">${fmt(l.unitPrice)}</td>
      <td class="num">${fmt(l.lineTotal)}</td>
    </tr>`
    )
    .join("");

  return `
  <div class="doc modern">
    <header>
      <div class="brand">${esc(inv.supplier)}</div>
      <div class="meta">
        <div><span>Invoice #</span><strong>${esc(inv.documentNumber)}</strong></div>
        <div><span>Date</span><strong>${esc(inv.documentDate)}</strong></div>
        <div><span>Currency</span><strong>${esc(inv.currency)}</strong></div>
      </div>
    </header>
    <table>
      <thead><tr><th>SKU</th><th>Description</th><th>Qty</th><th>Unit</th><th>Unit Price</th><th>Line Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals">
      <div><span>Subtotal</span><strong>${fmt(inv.subtotal)}</strong></div>
      ${inv.discount ? `<div><span>Discount</span><strong>-${fmt(inv.discount)}</strong></div>` : ""}
      <div><span>Tax</span><strong>${fmt(inv.tax)}</strong></div>
      <div class="grand"><span>Total Due</span><strong>${inv.currency} ${fmt(inv.total)}</strong></div>
    </div>
    ${inv.notes ? `<div class="notes">${esc(inv.notes)}</div>` : ""}
  </div>
  <style>
    .modern { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; padding: 40px; }
    .modern header { display: flex; justify-content: space-between; align-items: flex-start;
      border-bottom: 3px solid #2b5797; padding-bottom: 16px; margin-bottom: 24px; }
    .modern .brand { font-size: 26px; font-weight: 700; color: #2b5797; }
    .modern .meta div { display: flex; justify-content: space-between; gap: 20px; font-size: 13px; margin-bottom: 4px; }
    .modern .meta span { color: #666; }
    .modern table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .modern th { text-align: left; background: #2b5797; color: white; padding: 8px 10px; }
    .modern td { padding: 7px 10px; border-bottom: 1px solid #ddd; }
    .modern td.num, .modern th:nth-child(n+3) { text-align: right; }
    .modern td.sku { font-family: monospace; font-size: 11px; color: #555; }
    .modern .totals { margin-top: 18px; margin-left: auto; width: 280px; font-size: 13px; }
    .modern .totals div { display: flex; justify-content: space-between; padding: 4px 0; }
    .modern .totals .grand { border-top: 2px solid #2b5797; margin-top: 6px; padding-top: 8px; font-size: 16px; }
    .modern .notes { margin-top: 24px; font-size: 11px; color: #777; font-style: italic; }
  </style>`;
}

// Layout B — classic ledger, serif, ruled lines. Used by Harborside, Millbrook.
function layoutClassicLedger(inv: InvoiceGroundTruth): string {
  const rows = inv.lines
    .map(
      (l, i) => `
    <tr${i === 9 ? ' style="page-break-before: always;"' : ""}>
      <td class="num">${i + 1}</td>
      <td>${esc(l.description)}${l.sku ? ` <em>(${esc(l.sku)})</em>` : ""}</td>
      <td class="num">${l.quantity} ${esc(l.unit)}</td>
      <td class="num">${fmt(l.unitPrice)}</td>
      <td class="num">${fmt(l.lineTotal)}</td>
    </tr>`
    )
    .join("");

  return `
  <div class="doc ledger">
    <header>
      <h1>${esc(inv.supplier)}</h1>
      <div class="sub">Statement of Goods Supplied</div>
      <table class="meta-table">
        <tr><td>Document No.</td><td>${esc(inv.documentNumber)}</td><td>Date</td><td>${esc(inv.documentDate)}</td></tr>
      </table>
    </header>
    <table class="lines">
      <thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <table class="totals-table">
      <tr><td>Subtotal</td><td>${fmt(inv.subtotal)}</td></tr>
      ${inv.discount ? `<tr><td>Less: Discount</td><td>-${fmt(inv.discount)}</td></tr>` : ""}
      <tr><td>${inv.tax === "0.00" ? "Tax (zero-rated)" : "Tax"}</td><td>${fmt(inv.tax)}</td></tr>
      <tr class="grand"><td>Amount Due (${esc(inv.currency)})</td><td>${fmt(inv.total)}</td></tr>
    </table>
    ${inv.notes ? `<p class="notes">${esc(inv.notes)}</p>` : ""}
  </div>
  <style>
    .ledger { font-family: Georgia, "Times New Roman", serif; color: #222; padding: 40px; }
    .ledger h1 { font-size: 22px; margin: 0; letter-spacing: 0.5px; }
    .ledger .sub { font-size: 12px; color: #666; margin-bottom: 14px; font-variant: small-caps; }
    .ledger .meta-table { font-size: 12px; border-top: 1px solid #999; border-bottom: 1px solid #999;
      width: 100%; margin-bottom: 20px; }
    .ledger .meta-table td { padding: 5px 8px; }
    .ledger .meta-table td:nth-child(odd) { color: #666; width: 90px; }
    .ledger table.lines { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 16px; }
    .ledger table.lines th { text-align: left; border-bottom: 2px solid #222; padding: 6px 8px; font-weight: 600; }
    .ledger table.lines td { padding: 6px 8px; border-bottom: 1px dotted #bbb; }
    .ledger table.lines tr { page-break-inside: avoid; }
    .ledger table.lines .num, .ledger table.lines th:nth-child(n+3) { text-align: right; }
    .ledger table.lines em { color: #888; font-style: normal; font-size: 11px; }
    .ledger .totals-table { width: 260px; margin-left: auto; font-size: 13px; border-collapse: collapse; }
    .ledger .totals-table td { padding: 4px 8px; }
    .ledger .totals-table td:last-child { text-align: right; }
    .ledger .totals-table .grand td { border-top: 2px solid #222; font-weight: 700; font-size: 15px; padding-top: 8px; }
    .ledger .notes { font-size: 11px; color: #777; margin-top: 20px; font-style: italic; }
  </style>`;
}

// Layout C — compact/dense, condensed columns, mimics a delivery-driver printout. Coastal Meats.
function layoutCompactDense(inv: InvoiceGroundTruth): string {
  const rows = inv.lines
    .map(
      (l) => `
    <tr>
      <td>${l.sku ? esc(l.sku) : "-"}/${esc(l.description)}</td>
      <td class="num">${l.quantity}${esc(l.unit)}</td>
      <td class="num">@${fmt(l.unitPrice)}</td>
      <td class="num">${fmt(l.lineTotal)}</td>
    </tr>`
    )
    .join("");

  return `
  <div class="doc compact">
    <div class="head">
      <div class="name">${esc(inv.supplier).toUpperCase()}</div>
      <div class="ref">DOC ${esc(inv.documentNumber)} :: ${esc(inv.documentDate)} :: ${esc(inv.currency)}</div>
    </div>
    <table>
      <tbody>${rows}</tbody>
    </table>
    <div class="tot">
      SUBTOTAL ${fmt(inv.subtotal)}${inv.discount ? ` / DISC -${fmt(inv.discount)}` : ""} / TAX ${fmt(inv.tax)} / <b>TOTAL ${fmt(inv.total)}</b>
    </div>
    ${inv.notes ? `<div class="note"># ${esc(inv.notes)}</div>` : ""}
  </div>
  <style>
    .compact { font-family: "Courier New", monospace; font-size: 12px; color: #111; padding: 30px; width: 380px; }
    .compact .head { border-bottom: 1px dashed #000; padding-bottom: 8px; margin-bottom: 8px; }
    .compact .name { font-weight: 700; font-size: 15px; }
    .compact .ref { font-size: 10px; }
    .compact table { width: 100%; border-collapse: collapse; }
    .compact td { padding: 3px 0; vertical-align: top; }
    .compact td.num { text-align: right; white-space: nowrap; padding-left: 6px; }
    .compact .tot { border-top: 1px dashed #000; margin-top: 8px; padding-top: 8px; font-size: 11px; }
    .compact .note { margin-top: 10px; font-size: 10px; }
  </style>`;
}

const layoutBySupplier: Record<string, (inv: InvoiceGroundTruth) => string> = {
  "Nova Foods Ltd": layoutModernGrid,
  "Riverside Bakery Supply": layoutModernGrid,
  "Harborside Produce Co.": layoutClassicLedger,
  "Millbrook Dairy Cooperative": layoutClassicLedger,
  "Coastal Meats & Poultry": layoutCompactDense,
};

export function renderInvoiceHtml(inv: InvoiceGroundTruth): string {
  const layout = layoutBySupplier[inv.supplier] ?? layoutModernGrid;
  const body = layout(inv);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: white; }
  table { border-spacing: 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
