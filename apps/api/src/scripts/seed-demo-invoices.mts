// Loads .env.local so this script runs straight from a fresh clone (see load-env.ts).
import '@retailos/config/auto';
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
/**
 * Node built-ins only. These are hoisted above the `delete` below, which is fine — they read no
 * env. Everything that COULD observe GEMINI_API_KEY stays a dynamic `await import` further down,
 * so the key is genuinely absent by the time the server is constructed.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  // The demo account's real credentials — a stale password here fails the whole run on line one.
  payload: { email: 'demo@vyapaar.test', password: 'Vyapaar-Demo-Cafe-2026!' },
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
const stores = (JSON.parse(storesResponse.body) as { result: { data: { id: string; name: string }[] } }).result.data;

/**
 * Invoices are delivered to the outlet that ordered them, not all to the flagship. Routing every
 * document to `stores[0]` would put Jayanagar's and Koramangala's stock receipts on Indiranagar's
 * ledger, quietly corrupting per-outlet stock value and margin — the exact comparison the demo
 * exists to support. Corpus store CODES map to names, which is what the API exposes.
 */
const STORE_NAME_BY_CODE: Record<string, string> = {
  IND: 'Indiranagar',
  JAY: 'Jayanagar',
  KOR: 'Koramangala',
};
const storeIdByCode = new Map<string, string>();
for (const [code, name] of Object.entries(STORE_NAME_BY_CODE)) {
  const match = stores.find((s) => s.name === name);
  if (!match) {
    console.error(`No store named "${name}" (corpus code ${code}). Run seed-demo.mts first.`);
    process.exit(1);
  }
  storeIdByCode.set(code, match.id);
}

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
type Line = { sku: string; description: string; qty: string; unitPrice: string; lineTotal: string };
/** Totals come from the corpus (exact BigInt) rather than being recomputed here — see below. */
type Invoice = {
  supplier: string; number: string; date: string; storeCode: string;
  subtotal: string; cgst: string; sgst: string; total: string; lines: Line[];
};

/**
 * Exact 4dp addition via scaled BigInt, never float. Only ADDITION is needed here now: line totals
 * and invoice totals come from the corpus already computed, and the one thing this script derives
 * is CGST + SGST as a single tax figure for the extraction payload.
 */
const sumMoney = (values: string[]): string => {
  const total = values.reduce((sum, v) => {
    const [i = '0', f = ''] = v.split('.');
    return sum + BigInt(i + f.padEnd(4, '0').slice(0, 4));
  }, 0n);
  const s = total.toString().padStart(5, '0');
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
};

/**
 * READ FROM THE GENERATED CORPUS, not hardcoded here.
 *
 * `mock-data/documents/invoices.json` is produced by the deterministic generator, which already
 * computes every line total and GST split with exact scaled-BigInt arithmetic. Those values are
 * used AS-IS rather than recomputed: the pipeline runs an arithmetic validation gate on approval,
 * and two independent implementations of the same money maths are exactly how a seed drifts from
 * the corpus it claims to represent.
 *
 * The corpus also carries the planted price creep (one supplier's prices ratchet ~13% across the
 * window in discrete, threshold-crossing steps), which only becomes visible once these invoices
 * are posted and build real supplier price history.
 */
interface CorpusInvoiceLine {
  sku: string; supplierSku: string; description: string; hsn: string;
  qty: string; unitPrice: string; lineTotal: string; gstBasisPoints: number;
}
interface CorpusInvoice {
  number: string; supplierCode: string; supplierName: string; gstin: string; supplierAddress: string;
  date: string; storeCode: string; lines: CorpusInvoiceLine[];
  subtotal: string; cgst: string; sgst: string; total: string;
}

const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../mock-data');
const CORPUS_INVOICES: CorpusInvoice[] = JSON.parse(
  readFileSync(join(CORPUS_DIR, 'documents/invoices.json'), 'utf8')
) as CorpusInvoice[];

/**
 * Dates in the corpus are absolute strings fixed at generation time. Re-anchoring them to the
 * CURRENT date keeps invoices inside the same window as the seeded sales — an invoice dated before
 * the sales window would build price history that never applies to anything sold.
 */
const corpusGeneratedAt = new Date(
  (JSON.parse(readFileSync(join(CORPUS_DIR, 'meta.json'), 'utf8')) as { generatedAt: string }).generatedAt
);
const shiftDays = Math.round((Date.now() - corpusGeneratedAt.getTime()) / 86400000);
const reanchor = (isoDate: string): string => {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + shiftDays);
  return d.toISOString().slice(0, 10);
};

const INVOICES: Invoice[] = CORPUS_INVOICES.map((inv) => ({
  supplier: inv.supplierName,
  number: inv.number,
  date: reanchor(inv.date),
  storeCode: inv.storeCode,
  subtotal: inv.subtotal,
  cgst: inv.cgst,
  sgst: inv.sgst,
  total: inv.total,
  lines: inv.lines.map((l) => ({
    sku: l.supplierSku,
    description: l.description,
    qty: l.qty,
    unitPrice: l.unitPrice,
    lineTotal: l.lineTotal,
  })),
}));


// ---------------------------------------------------------------- the real PDF from the corpus
/**
 * Reuses the PDF the GENERATOR already produced, rather than rebuilding a lesser one here.
 *
 * The corpus PDFs carry four distinct per-supplier layouts (wholesaler / distributor / mandi /
 * corporate) with real GSTIN, HSN codes and a CGST/SGST split. Re-deriving a plainer PDF in this
 * script would mean the document a reviewer opens does not match the document the corpus describes
 * — and layout variation is exactly what makes extraction a real problem worth demonstrating.
 */
const pdfFor = (invoice: Invoice): Buffer =>
  readFileSync(join(CORPUS_DIR, 'documents/pdf', `${invoice.number.replace(/\//g, '-')}.pdf`));

// ---------------------------------------------------------------- run every invoice through the real path
/**
 * Already-posted invoice numbers, so a re-run resumes instead of duplicating.
 *
 * This matters more than convenience: approving a document POSTS it — price history, lots and
 * receipt movements. Re-posting the same invoice would double-count stock received, and because
 * `stock_movements` is append-only (I3) that cannot be undone by a later correction.
 *
 * The number lives in the extraction payload (`fields.documentNumber.value`) because that is where
 * the pipeline itself reads it from.
 */
const existingNumbers = new Set(
  (
    await db
      .select({ fields: documentExtractions.fields })
      .from(documentExtractions)
      .where(eq(documentExtractions.organizationId, organizationId))
  )
    .map((row) => (row.fields as { documentNumber?: { value?: string } })?.documentNumber?.value)
    .filter((n): n is string => typeof n === 'string')
);
if (existingNumbers.size > 0) {
  console.log(`Resuming: ${existingNumbers.size} invoice(s) already posted, skipping those.`);
}

const seeded: string[] = [];
let skipped = 0;
for (const invoice of INVOICES) {
  if (existingNumbers.has(invoice.number)) {
    skipped += 1;
    continue;
  }
  // Each invoice lands at the outlet it was actually delivered to.
  const storeId = storeIdByCode.get(invoice.storeCode)!;
  const requestResponse = await app.inject({ method: 'POST', url: '/trpc/documents.requestUpload', payload: { storeId }, cookies });
  const { uploadUrl, key } = (JSON.parse(requestResponse.body) as { result: { data: { uploadUrl: string; key: string } } }).result.data;
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: pdfFor(invoice) });
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
  /**
   * Best-effort. If a worker is running it may already hold the lock, and BullMQ throws rather than
   * returning false — which crashed an earlier run mid-corpus. A locked job is a warning, not a
   * reason to abandon the remaining invoices: the consequence is a live extraction overwriting this
   * seeded one, which the operator can avoid by stopping the worker (as the header says).
   */
  try {
    await (await extractionQueue.getJob(documentId))?.remove();
  } catch (err) {
    console.warn(
      `  note: could not remove extraction job for ${invoice.number} (${(err as Error).message}). ` +
        'Stop the worker (pnpm dev) before seeding so it cannot re-extract over the seeded rows.'
    );
  }

  /**
   * Totals come straight from the corpus. Recomputing them here would be a SECOND implementation of
   * the same money maths, and any drift between the two would surface as a false failure in the
   * pipeline's arithmetic validation gate — the gate would be right and the seed wrong.
   */
  const lineTotal = (l: Line): string => l.lineTotal;
  const total = invoice.total;
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
      // A real Indian tax invoice splits GST into CGST + SGST. The extraction carries their SUM as
      // one tax figure (the shape the pipeline validates: subtotal + tax = total), while the split
      // itself stays visible on the PDF where a reviewer would actually look for it.
      subtotal: { value: invoice.subtotal, confidence: 0.95 },
      tax: { value: sumMoney([invoice.cgst, invoice.sgst]), confidence: 0.9 },
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

console.log(
  JSON.stringify(
    { seededDocuments: seeded.length, skippedAlreadyPosted: skipped, totalInCorpus: INVOICES.length },
    null,
    2
  )
);
console.log('Embedding jobs are queued — run the worker with the real key to embed:');
console.log('  pnpm --filter @retailos/worker dev');
await app.close();
process.exit(0);
