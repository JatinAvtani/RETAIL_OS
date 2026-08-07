import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { ExtractedField, ExtractedFields, ExtractedLine, ExtractionProvider, ExtractionResult } from './extraction-provider';

const execFileAsync = promisify(execFile);

/**
 * `docker run` for `jitesoft/tesseract-ocr`/`minidocks/poppler` is genuinely much slower on GitHub
 * Actions' runner than on a dev machine with a warm image cache and a faster CPU — confirmed
 * directly: a named-container `docker kill` (see `runDockerContainer` below) reliably cuts off a
 * stuck run, and doing so at 20s surfaced that CI needed MORE than 20s, not that the process was
 * hung forever. 90s gives real headroom for a cold image pull plus Tesseract's own OCR pass on that
 * runner's weaker CPU, while still bounding a genuine, unbounded stall if one ever occurs — the
 * `execFile` `timeout` option was tried first and confirmed to have zero effect on this runner
 * (`docker run` without `-it` doesn't reliably forward a signal sent to the CLI process into the
 * actual container, so the CLI's own wait-for-exit call can outlive it); `docker kill` at the
 * daemon level is what actually works, independent of the CLI's own signal handling.
 */
const DOCKER_RUN_TIMEOUT_MS = 90_000;

/**
 * Runs `docker run` with an explicit `--name`, racing it against `DOCKER_RUN_TIMEOUT_MS`. On
 * timeout, issues a real `docker kill <name>` (best-effort — the container may have already exited)
 * before rejecting, so a genuinely stuck container doesn't linger consuming resources after this
 * function gives up on it.
 */
const runDockerContainer = async (args: string[]): Promise<void> => {
  const containerName = `retailos-ocr-${randomUUID()}`;
  const fullArgs = ['run', '--rm', '--name', containerName, ...args];

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    execFile('docker', ['kill', containerName], () => {
      // Best-effort: the container may have already finished on its own between the timeout
      // firing and this kill attempt landing — a failure here is not itself an error worth
      // surfacing, the run's own rejection below is what the caller sees.
    });
  }, DOCKER_RUN_TIMEOUT_MS);

  try {
    await execFileAsync('docker', fullArgs, { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  } catch (e) {
    if (timedOut) {
      throw new Error(`docker run timed out after ${DOCKER_RUN_TIMEOUT_MS}ms and was killed: ${fullArgs.join(' ')}`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const NULL_FIELD: ExtractedField = { value: null, confidence: null };
/** Tesseract gives no semantic confidence — every non-null field gets a null confidence rather than a fabricated number, so it never reads as "the model was uncertain" when really it's "this OCR engine has no concept of confidence at all" (I7's reasoning applied to metadata, not just values). */
const field = (value: string | null): ExtractedField => (value === null ? NULL_FIELD : { value, confidence: null });

/**
 * 007-06 (plan.md Phase 2, "dual provider... circuit breaker; fall back on outage"): the real
 * secondary `ExtractionProvider`, ported from EPIC-002's own validated spike
 * (`spikes/extraction/src/providers/tesseract.ts`) — free, no API key, runs locally via one-off
 * Docker containers (Docker Desktop already runs Postgres/Redis/MinIO for this project, so this
 * adds no new infrastructure dependency locally; a real deployment would need Docker available to
 * the worker process, a real operational constraint worth knowing, not hidden).
 *
 * **Confirmed directly (not assumed) that `jitesoft/tesseract-ocr`/Tesseract itself cannot read
 * PDFs at all** — Leptonica hard-errors ("Pdf reading is not supported"). Since most real invoices
 * in this pipeline are PDFs, a PDF input is rasterized to PNG first via `minidocks/poppler`'s
 * `pdftoppm` (a second one-off container, matching the tesseract provider's own established
 * pattern) — without this step, the fallback would be useless for the majority of real documents,
 * defeating the point of having one. `pdftoppm`'s own output-file zero-padding depends on the
 * PDF's TOTAL page count (confirmed directly against poppler's C++ source, not documented in its
 * man page) — never assumed a fixed digit width; output files are globbed and sorted numerically.
 *
 * The spike's own measured accuracy for this exact parser: correct on roughly half of a clean,
 * modern-grid invoice's header fields and ALL line items on a compact/dense layout (0 lines
 * parsed). This is real, honest, degraded output — not fabricated — and exactly the trade-off a
 * circuit-breaker fallback is supposed to make: worse extraction is still better than none during
 * a real Gemini outage, with every gap represented as `null`, never a guess.
 */
const ocrImage = async (imagePath: string): Promise<string> => {
  const dir = path.dirname(imagePath);
  const base = path.basename(imagePath, path.extname(imagePath));
  const outBase = `${base}.tesseract-out`;

  const dockerMountPath = dir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `//${d.toLowerCase()}`);

  await runDockerContainer(['--entrypoint', 'tesseract', '-v', `${dockerMountPath}:/data`, 'jitesoft/tesseract-ocr', `/data/${path.basename(imagePath)}`, `/data/${outBase}`, '--psm', '6']);

  const text = await readFile(path.join(dir, `${outBase}.txt`), 'utf-8');
  await rm(path.join(dir, `${outBase}.txt`), { force: true });
  return text;
};

/** Rasterizes every page of a PDF to PNG via `minidocks/poppler`'s `pdftoppm`, returning the resulting image paths in real page order (globbed + sorted numerically, never assuming a fixed zero-padded filename width — confirmed that width depends on the PDF's total page count, not a constant). */
const rasterizePdfToImages = async (pdfPath: string, outDir: string): Promise<string[]> => {
  const dockerMountPath = outDir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `//${d.toLowerCase()}`);
  const pdfBase = path.basename(pdfPath);

  await runDockerContainer(['-v', `${dockerMountPath}:/data`, 'minidocks/poppler', 'pdftoppm', '-png', `/data/${pdfBase}`, '/data/page']);

  const files = await readdir(outDir);
  const pageFiles = files.filter((f) => f.startsWith('page-') && f.endsWith('.png'));
  pageFiles.sort((a, b) => {
    const numA = Number(a.match(/page-(\d+)\.png$/)?.[1] ?? 0);
    const numB = Number(b.match(/page-(\d+)\.png$/)?.[1] ?? 0);
    return numA - numB;
  });
  return pageFiles.map((f) => path.join(outDir, f));
};

const MONEY = String.raw`\(?[\$]?\s*[\d.,]+\)?`;
const LINE_PATTERN = new RegExp(String.raw`^(.*?)\s+(\d+(?:\.\d+)?)\s+(\w+)\s+(${MONEY})\s+(${MONEY})\s*$`);

const cleanMoney = (v: string): string => v.replace(/[()$\s]/g, '');

const parseLines = (text: string): ExtractedLine[] => {
  const lines: ExtractedLine[] = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    const match = trimmed.match(LINE_PATTERN);
    if (!match) continue;

    const [, descAndSku, qty, unit, unitPrice, lineTotal] = match;
    const skuMatch = descAndSku!.trim().match(/^([A-Z0-9][A-Z0-9-]{3,})\s+(.*)$/);
    const sku = skuMatch ? skuMatch[1]! : null;
    const description = skuMatch ? skuMatch[2]! : descAndSku!.trim();
    if (!description) continue;

    lines.push({
      sku: field(sku),
      description: field(description),
      quantity: field(qty!),
      unit: field(unit!),
      unitPrice: field(cleanMoney(unitPrice!)),
      lineTotal: field(cleanMoney(lineTotal!)),
    });
  }
  return lines;
};

const extractField = (text: string, patterns: RegExp[]): string | null => {
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return null;
};

const parseHeader = (text: string): ExtractedFields => {
  const supplier = extractField(text, [/^([A-Z][A-Za-z&.,' ]{3,40}?)\s*\n/m]);
  const documentNumber = extractField(text, [/(?:invoice\s*#|doc(?:ument)?\s*no\.?|inv[-\s]?)[:\s]*([A-Z0-9-]+)/i]);
  const dateRaw = extractField(text, [/(\d{4}[.\-/]\d{2}[.\-/]\d{2})/, /date[:\s]*([\d.\-/]+)/i]);
  const documentDate = dateRaw ? dateRaw.replace(/[./]/g, '-') : null;
  const currency = extractField(text, [/\b(USD|EUR|GBP)\b/]);
  const subtotal = extractField(text, [/subtotal[:\s]*\(?\$?([\d.,]+)\)?/i]);
  const tax = extractField(text, [/tax[:\s]*\(?\$?([\d.,]+)\)?/i]);
  const total = extractField(text, [/total\s*(?:due|amount)?[:\s]*(?:usd|eur|gbp)?\s*\(?\$?([\d.,]+)\)?/i]);
  const discount = extractField(text, [/discount[:\s]*-?\(?\$?([\d.,]+)\)?/i]);

  return {
    supplier: field(supplier),
    documentNumber: field(documentNumber),
    documentDate: field(documentDate),
    currency: field(currency),
    subtotal: field(subtotal ? cleanMoney(subtotal) : null),
    tax: field(tax ? cleanMoney(tax) : null),
    discount: field(discount ? cleanMoney(discount) : null),
    total: field(total ? cleanMoney(total) : null),
  };
};

export const createTesseractExtractionProvider = (): ExtractionProvider => ({
  name: 'tesseract',

  async extract(bytes: Buffer, mimeType: string): Promise<ExtractionResult> {
    const started = Date.now();
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'tesseract-provider-'));
    // Both images run as a fixed, non-root container UID (jitesoft/tesseract-ocr: UID 472;
    // minidocks/poppler: root, but still a different UID than the host process on Linux). Docker
    // Desktop's bind-mount layer on Windows/Mac ignores host Unix permissions, so mkdtemp's default
    // 0700 mode never mattered there — but on a real Linux host (confirmed: broke in CI, never
    // locally) the container UID has no access to a directory it doesn't own, so the write into the
    // mount fails silently and the expected output file never appears. World-writable for this
    // directory's brief, process-private lifetime (deleted in `finally` below) is the standard fix
    // for this exact bind-mount UID mismatch.
    await chmod(tmpDir, 0o777);

    try {
      let imagePaths: string[];
      if (mimeType === 'application/pdf') {
        const pdfPath = path.join(tmpDir, 'input.pdf');
        await writeFile(pdfPath, bytes);
        imagePaths = await rasterizePdfToImages(pdfPath, tmpDir);
        if (imagePaths.length === 0) {
          return { provider: 'tesseract', modelVersion: 'tesseract-5.5.2', latencyMs: Date.now() - started, error: 'PDF rasterization produced no pages', fields: null, lines: null, overallConfidence: null };
        }
      } else {
        const ext = mimeType === 'image/png' ? 'png' : 'jpg';
        const imgPath = path.join(tmpDir, `page-0.${ext}`);
        await writeFile(imgPath, bytes);
        imagePaths = [imgPath];
      }

      let combinedText = '';
      for (let i = 0; i < imagePaths.length; i++) {
        const text = await ocrImage(imagePaths[i]!);
        combinedText += (i > 0 ? '\n' : '') + text;
      }

      const fields = parseHeader(combinedText);
      const lines = parseLines(combinedText);

      return {
        provider: 'tesseract',
        modelVersion: 'tesseract-5.5.2',
        latencyMs: Date.now() - started,
        error: null,
        fields,
        lines,
        overallConfidence: null, // Tesseract's regex parser has no semantic confidence at all — never fabricated.
      };
    } catch (e) {
      return { provider: 'tesseract', modelVersion: 'tesseract-5.5.2', latencyMs: Date.now() - started, error: (e as Error).message, fields: null, lines: null, overallConfidence: null };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
});
