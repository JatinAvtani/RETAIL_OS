/**
 * Seeds a realistic invoice corpus for the demo org through the REAL pipeline surface: every
 * document goes through the actual `documents.requestUpload` → PUT to object storage →
 * `confirmUpload` → `approve` HTTP endpoints, so posting (price history, lots, receipt
 * movements), the three-way match, and the embedding-job enqueue all fire exactly as they would
 * for a customer upload. Only the model-side extraction is bypassed — the extraction row is
 * inserted directly (the same recipe the document tests use), because a seed must be
 * deterministic and quota-independent while everything downstream of extraction stays real.
 *
 * The GEMINI key is deleted from this process's env BEFORE the server is imported, so
 * `confirmUpload` takes its documented deterministic no-key path; each enqueued extraction job is
 * then removed so a later-running worker doesn't re-extract over the seeded rows (a failed live
 * extraction attempt is recorded as a data point by design, which here would bury the seed's
 * extraction as no-longer-latest). Embedding jobs are left in the queue on purpose: run the real
 * worker afterwards to produce document + chunk embeddings via the real embedding model.
 *
 * Usage: (env with DATABASE_URL/REDIS_URL/S3_*; GEMINI_API_KEY may be set — it is removed)
 *   pnpm --filter @retailos/api exec tsx src/scripts/seed-demo-invoices.mts
 */
delete process.env.GEMINI_API_KEY;

const { buildServer } = await import('../server');
const { extractionQueue } = await import('../trpc/context');
const { createDb, documents, documentExtractions, users, memberships } = await import('@retailos/db');
const { generateId } = await import('@retailos/domain');
const { eq } = await import('drizzle-orm');

const { db } = createDb(process.env.DATABASE_URL!);
const app = buildServer({ logger: false });
await app.ready();

// ---------------------------------------------------------------- login (real HTTP)
const loginResponse = await app.inject({
  method: 'POST',
  url: '/trpc/auth.login',
  payload: { email: 'demo@vyapaar.test', password: 'DemoPass123!' },
});
if (loginResponse.statusCode !== 200) {
  console.error('Login failed:', loginResponse.statusCode, loginResponse.body.slice(0, 200));
  process.exit(1);
}
const sessionCookie = loginResponse.cookies.find((c) => c.name === '__Host-session')?.value;
if (!sessionCookie) {
  console.error('No session cookie in login response.');
  process.exit(1);
}
const cookies = { '__Host-session': sessionCookie };

const storesResponse = await app.inject({ method: 'GET', url: '/trpc/stores.list', cookies });
const stores = (JSON.parse(storesResponse.body) as { result: { data: { id: string }[] } }).result.data;
const storeId = stores[0]!.id;

// The demo user's own org id, straight from their accepted membership — never assumed from a
// response shape this script doesn't own.
const [membershipRow] = await db
  .select({ organizationId: memberships.organizationId })
  .from(memberships)
  .innerJoin(users, eq(users.id, memberships.userId))
  .where(eq(users.email, 'demo@vyapaar.test'));
const organizationId = membershipRow!.organizationId;

// ---------------------------------------------------------------- the corpus
// Pack prices drift around the org's real current supplier_prices, so posting's price-change
// detection sees believable movement (flour takes a genuine ~8% step up mid-series). Quantities
// are whole packs; line totals are exact qty × unitPrice so the arithmetic validation gate holds.
type Line = { sku: string; description: string; qty: string; unitPrice: string };
type Invoice = { supplier: string; number: string; date: string; lines: Line[] };

/**
 * qty (a whole-pack count) × a 4dp price string, exactly, via scaled BigInt — the invariant
 * scanner rightly flagged this file's first draft for float money math, and a seed whose line
 * totals drift from qty × price by a floating-point hair would trip the pipeline's own arithmetic
 * validation gate, which is proof the gate works, not data worth seeding.
 */
const mulPackPrice = (qty: string, unitPrice: string): string => {
  const [intPart = '0', fracPart = ''] = unitPrice.split('.');
  const scaled = BigInt(intPart + fracPart.padEnd(4, '0').slice(0, 4)) * BigInt(qty);
  const s = scaled.toString().padStart(5, '0');
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
};

const sumMoney = (values: string[]): string => {
  const total = values.reduce((sum, v) => {
    const [i = '0', f = ''] = v.split('.');
    return sum + BigInt(i + f.padEnd(4, '0').slice(0, 4));
  }, 0n);
  const s = total.toString().padStart(5, '0');
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
};

const INVOICES: Invoice[] = [
  { supplier: 'Northgate Millers', number: 'NM-2026-1104', date: '2026-06-02', lines: [
    { sku: 'FLR-00-PACK', description: 'Flour tipo 00, 25kg sack', qty: '6', unitPrice: '24.0000' },
    { sku: 'SGR-CST-PACK', description: 'Caster sugar, 10kg', qty: '3', unitPrice: '18.0000' },
    { sku: 'YST-FRS-PACK', description: 'Fresh yeast, 1kg block', qty: '4', unitPrice: '11.2000' } ] },
  { supplier: 'Hollow Creek Creamery', number: 'HCC-8841', date: '2026-06-05', lines: [
    { sku: 'BTR-UNS-PACK', description: 'Butter unsalted, 5kg', qty: '4', unitPrice: '38.5000' },
    { sku: 'MLK-WHL-PACK', description: 'Whole milk, 12L crate', qty: '6', unitPrice: '14.4000' },
    { sku: 'EGG-LRG-PACK', description: 'Eggs large, tray of 60', qty: '5', unitPrice: '9.6000' } ] },
  { supplier: 'Northgate Millers', number: 'NM-2026-1178', date: '2026-06-16', lines: [
    { sku: 'FLR-00-PACK', description: 'Flour tipo 00, 25kg sack', qty: '8', unitPrice: '24.0000' },
    { sku: 'CFE-ESP-PACK', description: 'Espresso beans, 2kg', qty: '5', unitPrice: '46.0000' },
    { sku: 'SLT-SEA-PACK', description: 'Sea salt, 2kg', qty: '2', unitPrice: '6.5000' } ] },
  { supplier: 'Hollow Creek Creamery', number: 'HCC-8903', date: '2026-06-19', lines: [
    { sku: 'BTR-UNS-PACK', description: 'Butter unsalted, 5kg', qty: '3', unitPrice: '38.5000' },
    { sku: 'MLK-WHL-PACK', description: 'Whole milk, 12L crate', qty: '8', unitPrice: '14.6000' } ] },
  { supplier: 'Northgate Millers', number: 'NM-2026-1240', date: '2026-06-30', lines: [
    { sku: 'FLR-00-PACK', description: 'Flour tipo 00, 25kg sack', qty: '6', unitPrice: '24.5000' },
    { sku: 'SGR-CST-PACK', description: 'Caster sugar, 10kg', qty: '4', unitPrice: '18.0000' },
    { sku: 'YST-FRS-PACK', description: 'Fresh yeast, 1kg block', qty: '4', unitPrice: '11.2000' } ] },
  { supplier: 'Hollow Creek Creamery', number: 'HCC-8967', date: '2026-07-03', lines: [
    { sku: 'EGG-LRG-PACK', description: 'Eggs large, tray of 60', qty: '6', unitPrice: '9.8000' },
    { sku: 'MLK-WHL-PACK', description: 'Whole milk, 12L crate', qty: '6', unitPrice: '14.6000' } ] },
  // The flour price step: 24.50 → 26.50 (+8.2%) — a genuine, threshold-crossing change.
  { supplier: 'Northgate Millers', number: 'NM-2026-1305', date: '2026-07-14', lines: [
    { sku: 'FLR-00-PACK', description: 'Flour tipo 00, 25kg sack', qty: '8', unitPrice: '26.5000' },
    { sku: 'CFE-ESP-PACK', description: 'Espresso beans, 2kg', qty: '4', unitPrice: '46.0000' } ] },
  { supplier: 'Hollow Creek Creamery', number: 'HCC-9024', date: '2026-07-17', lines: [
    { sku: 'BTR-UNS-PACK', description: 'Butter unsalted, 5kg', qty: '4', unitPrice: '39.2000' },
    { sku: 'MLK-WHL-PACK', description: 'Whole milk, 12L crate', qty: '7', unitPrice: '14.6000' },
    { sku: 'EGG-LRG-PACK', description: 'Eggs large, tray of 60', qty: '5', unitPrice: '9.8000' } ] },
  { supplier: 'Northgate Millers', number: 'NM-2026-1377', date: '2026-07-28', lines: [
    { sku: 'FLR-00-PACK', description: 'Flour tipo 00, 25kg sack', qty: '7', unitPrice: '26.5000' },
    { sku: 'SGR-CST-PACK', description: 'Caster sugar, 10kg', qty: '3', unitPrice: '18.4000' },
    { sku: 'SLT-SEA-PACK', description: 'Sea salt, 2kg', qty: '2', unitPrice: '6.5000' } ] },
  { supplier: 'Hollow Creek Creamery', number: 'HCC-9101', date: '2026-08-01', lines: [
    { sku: 'BTR-UNS-PACK', description: 'Butter unsalted, 5kg', qty: '5', unitPrice: '39.2000' },
    { sku: 'EGG-LRG-PACK', description: 'Eggs large, tray of 60', qty: '6', unitPrice: '9.8000' } ] },
  { supplier: 'Northgate Millers', number: 'NM-2026-1440', date: '2026-08-11', lines: [
    { sku: 'FLR-00-PACK', description: 'Flour tipo 00, 25kg sack', qty: '8', unitPrice: '26.5000' },
    { sku: 'YST-FRS-PACK', description: 'Fresh yeast, 1kg block', qty: '5', unitPrice: '11.4000' },
    { sku: 'CFE-ESP-PACK', description: 'Espresso beans, 2kg', qty: '5', unitPrice: '46.0000' } ] },
  { supplier: 'Hollow Creek Creamery', number: 'HCC-9165', date: '2026-08-14', lines: [
    { sku: 'MLK-WHL-PACK', description: 'Whole milk, 12L crate', qty: '8', unitPrice: '14.8000' },
    { sku: 'BTR-UNS-PACK', description: 'Butter unsalted, 5kg', qty: '3', unitPrice: '39.2000' } ] },
];

// ---------------------------------------------------------------- a minimal real PDF per invoice
// A valid single-page PDF with the invoice text as an uncompressed stream — enough for the review
// screen's presigned download to open something real rather than a broken object.
const buildPdf = (invoice: Invoice): Buffer => {
  const display = (v4dp: string): string => v4dp.slice(0, -2); // 4dp → 2dp for the printed page
  const total = sumMoney(invoice.lines.map((l) => mulPackPrice(l.qty, l.unitPrice)));
  const textLines = [
    `${invoice.supplier}`,
    `TAX INVOICE  ${invoice.number}`,
    `Date: ${invoice.date}`,
    `Bill to: Ardent Bakehouse, Mill Street`,
    ``,
    ...invoice.lines.map((l) => `${l.sku}  ${l.description}  x${l.qty} @ ${l.unitPrice}  = ${display(mulPackPrice(l.qty, l.unitPrice))}`),
    ``,
    `TOTAL DUE: ${display(total)} INR`,
  ];
  const escape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = [
    'BT /F1 10 Tf 40 800 Td 14 TL',
    ...textLines.map((l) => `(${escape(l)}) Tj T*`),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) body += `${String(at).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(body, 'latin1');
};

// ---------------------------------------------------------------- run every invoice through the real path
const seeded: string[] = [];
for (const invoice of INVOICES) {
  const requestResponse = await app.inject({ method: 'POST', url: '/trpc/documents.requestUpload', payload: { storeId }, cookies });
  const { uploadUrl, key } = (JSON.parse(requestResponse.body) as { result: { data: { uploadUrl: string; key: string } } }).result.data;
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: buildPdf(invoice) });
  if (!put.ok) {
    console.error(`PUT failed for ${invoice.number}: ${put.status}`);
    process.exit(1);
  }

  const confirmResponse = await app.inject({ method: 'POST', url: '/trpc/documents.confirmUpload', payload: { storeId, key }, cookies });
  if (confirmResponse.statusCode !== 200) {
    console.error(`confirmUpload failed for ${invoice.number}: ${confirmResponse.body.slice(0, 200)}`);
    process.exit(1);
  }
  const { documentId } = (JSON.parse(confirmResponse.body) as { result: { data: { documentId: string } } }).result.data;

  // Remove the extraction job confirmUpload just enqueued — see the header for why.
  await (await extractionQueue.getJob(documentId))?.remove();

  const lineTotal = (l: Line): string => mulPackPrice(l.qty, l.unitPrice);
  const total = sumMoney(invoice.lines.map((l) => mulPackPrice(l.qty, l.unitPrice)));
  await db.insert(documentExtractions).values({
    id: generateId(),
    organizationId,
    documentId,
    provider: 'gemini',
    modelVersion: 'seed-corpus',
    promptVersion: '1',
    fields: {
      supplier: { value: invoice.supplier, confidence: 0.97 },
      documentNumber: { value: invoice.number, confidence: 0.98 },
      documentDate: { value: invoice.date, confidence: 0.98 },
      currency: { value: 'INR', confidence: 0.99 },
      subtotal: { value: total, confidence: 0.95 },
      tax: { value: '0', confidence: 0.9 },
      discount: { value: null, confidence: null },
      total: { value: total, confidence: 0.97 },
    },
    lines: invoice.lines.map((l) => ({
      sku: { value: l.sku, confidence: 0.96 },
      description: { value: l.description, confidence: 0.95 },
      quantity: { value: l.qty, confidence: 0.97 },
      unitPrice: { value: l.unitPrice, confidence: 0.96 },
      lineTotal: { value: lineTotal(l), confidence: 0.96 },
    })),
    validation: { issues: [], canAutoApprove: false },
    overallConfidence: '0.9500',
  });
  await db.update(documents).set({ status: 'REVIEW_REQUIRED', type: 'INVOICE' }).where(eq(documents.id, documentId));

  const approveResponse = await app.inject({ method: 'POST', url: '/trpc/documents.approve', payload: { documentId }, cookies });
  if (approveResponse.statusCode !== 200) {
    console.error(`approve failed for ${invoice.number}: ${approveResponse.body.slice(0, 300)}`);
    process.exit(1);
  }
  seeded.push(documentId);
  console.log(`${invoice.number} (${invoice.supplier}) → approved, posted, match attempted`);
}

console.log(JSON.stringify({ seededDocuments: seeded.length }, null, 2));
console.log('Embedding jobs are queued — run the worker with the real key to embed:');
console.log('  pnpm --filter @retailos/worker dev');
await app.close();
process.exit(0);
