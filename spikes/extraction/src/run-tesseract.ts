import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTesseractProvider } from "./providers/tesseract.js";
import type { ExtractionProvider } from "./providers/types.js";

const CLEAN_DIR = path.resolve(import.meta.dirname, "../corpus/clean");
const DEGRADED_DIR = path.resolve(import.meta.dirname, "../corpus/degraded");
const RESULTS_DIR = path.resolve(import.meta.dirname, "../results");

interface InvoiceFileGroup {
  invoiceId: string;
  imagePaths: string[];
  mimeType: string;
}

async function groupFiles(dir: string, ext: string, mimeType: string): Promise<InvoiceFileGroup[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(`.${ext}`));
  const groups = new Map<string, string[]>();

  for (const file of files) {
    const withoutExt = file.slice(0, -(ext.length + 1));
    const pageMatch = withoutExt.match(/^(.+)\.p(\d+)$/);
    const invoiceId = pageMatch ? pageMatch[1]! : withoutExt;
    const existing = groups.get(invoiceId) ?? [];
    existing.push(file);
    groups.set(invoiceId, existing);
  }

  return Array.from(groups.entries()).map(([invoiceId, fileNames]) => ({
    invoiceId,
    imagePaths: fileNames.sort().map((f) => path.join(dir, f)),
    mimeType,
  }));
}

async function runVariant(variant: "clean" | "degraded", dir: string, ext: string, mimeType: string, provider: ExtractionProvider): Promise<void> {
  const groups = await groupFiles(dir, ext, mimeType);
  const outDir = path.join(RESULTS_DIR, provider.name, variant);
  await mkdir(outDir, { recursive: true });

  console.log(`\n--- ${provider.name} / ${variant} (${groups.length} invoices) ---`);

  for (const group of groups) {
    const buffers = await Promise.all(group.imagePaths.map((p) => readFile(p)));
    const result = await provider.extract(buffers, mimeType, group.invoiceId);
    const status = result.error ? `ERROR: ${result.error}` : `ok (${result.lines?.length ?? 0} lines parsed, ${result.latencyMs}ms)`;
    console.log(`  ${group.invoiceId}: ${status}`);
    await writeFile(path.join(outDir, `${group.invoiceId}.json`), JSON.stringify(result, null, 2), "utf-8");
  }
}

async function main() {
  const provider = createTesseractProvider();
  await runVariant("clean", CLEAN_DIR, "png", "image/png", provider);
  await runVariant("degraded", DEGRADED_DIR, "jpg", "image/jpeg", provider);
  console.log(`\nDone. Results in ${RESULTS_DIR}/${provider.name}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
