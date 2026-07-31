import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtractionProvider, ExtractionResult, ExtractedField, ExtractedLine } from "./types.js";

const execFileAsync = promisify(execFile);

const NULL_FIELD: ExtractedField = { value: null, confidence: null };
function field(value: string | null): ExtractedField {
  // Tesseract gives no semantic confidence — every non-null field gets a flat
  // placeholder so it doesn't get misread as "the model was uncertain".
  return value === null ? NULL_FIELD : { value, confidence: null };
}

// Runs `tesseract` via a one-off Docker container. No key, no account — the
// deliberate floor/calibration baseline: if Gemini barely beats this, the
// prompt is the problem, not the model.
async function ocrImage(imagePath: string): Promise<string> {
  const dir = path.dirname(imagePath);
  const base = path.basename(imagePath, path.extname(imagePath));
  const outBase = `${base}.tesseract-out`;

  // Docker Desktop on Windows needs a forward-slash path with the drive
  // letter as a pseudo-root (C:\foo\bar -> //c/foo/bar). MSYS_NO_PATHCONV
  // stops Git Bash from re-mangling the /data paths in the command args.
  const dockerMountPath = dir.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `//${d.toLowerCase()}`);

  await execFileAsync(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "tesseract",
      "-v",
      `${dockerMountPath}:/data`,
      "jitesoft/tesseract-ocr",
      `/data/${path.basename(imagePath)}`,
      `/data/${outBase}`,
      "--psm",
      "6",
    ],
    { env: { ...process.env, MSYS_NO_PATHCONV: "1" } }
  );

  const text = await readFile(path.join(dir, `${outBase}.txt`), "utf-8");
  await rm(path.join(dir, `${outBase}.txt`), { force: true });
  return text;
}

// Heuristic line-item parser: looks for rows ending in two decimal numbers
// (unitPrice, lineTotal) preceded by a quantity, which is the shape every
// fixture layout's line items take. This is intentionally crude — it is the
// floor baseline, not a real extraction pipeline.
const MONEY = String.raw`\(?[\$]?\s*[\d.,]+\)?`;
const LINE_PATTERN = new RegExp(
  String.raw`^(.*?)\s+(\d+(?:\.\d+)?)\s+(\w+)\s+(${MONEY})\s+(${MONEY})\s*$`
);

function parseLines(text: string): ExtractedLine[] {
  const lines: ExtractedLine[] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    const match = trimmed.match(LINE_PATTERN);
    if (!match) continue;

    const [, descAndSku, qty, unit, unitPrice, lineTotal] = match;
    // crude SKU split: leading token with a hyphen and no lowercase-word-only shape
    const skuMatch = descAndSku!.trim().match(/^([A-Z0-9][A-Z0-9-]{3,})\s+(.*)$/);
    const sku = skuMatch ? skuMatch[1]! : null;
    const description = skuMatch ? skuMatch[2]! : descAndSku!.trim();

    if (!description) continue; // skip header/total rows that happen to match the shape

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
}

function cleanMoney(v: string): string {
  return v.replace(/[()$\s]/g, "");
}

function extractField(text: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function parseHeader(text: string) {
  const supplier = extractField(text, [/^([A-Z][A-Za-z&.,' ]{3,40}?)\s*\n/m]);
  const documentNumber = extractField(text, [/(?:invoice\s*#|doc(?:ument)?\s*no\.?|inv[-\s]?)[:\s]*([A-Z0-9-]+)/i]);
  const dateRaw = extractField(text, [/(\d{4}[.\-/]\d{2}[.\-/]\d{2})/, /date[:\s]*([\d.\-/]+)/i]);
  const documentDate = dateRaw ? dateRaw.replace(/[./]/g, "-") : null;
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
}

export function createTesseractProvider(): ExtractionProvider {
  return {
    name: "tesseract-5.5.2",

    async extract(images: Buffer[], mimeType: string, fileLabel: string): Promise<ExtractionResult> {
      const started = Date.now();
      const tmpDir = await mkdtemp(path.join(tmpdir(), "tesseract-spike-"));

      try {
        const ext = mimeType === "image/png" ? "png" : "jpg";
        let combinedText = "";

        for (let i = 0; i < images.length; i++) {
          const imgPath = path.join(tmpDir, `page-${i}.${ext}`);
          await writeFile(imgPath, images[i]!);
          const text = await ocrImage(imgPath);
          combinedText += (i > 0 ? "\n" : "") + text;
        }

        const fields = parseHeader(combinedText);
        const lines = parseLines(combinedText);

        return {
          provider: "tesseract-5.5.2",
          file: fileLabel,
          latencyMs: Date.now() - started,
          error: null,
          fields,
          lines,
          raw: combinedText,
        };
      } catch (e) {
        return {
          provider: "tesseract-5.5.2",
          file: fileLabel,
          latencyMs: Date.now() - started,
          error: (e as Error).message,
          fields: null,
          lines: null,
          raw: null,
        };
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  };
}
