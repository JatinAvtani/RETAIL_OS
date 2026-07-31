import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGeminiProvider } from "./providers/gemini.js";
import type { ExtractionProvider, ExtractionResult } from "./providers/types.js";

const CLEAN_DIR = path.resolve(import.meta.dirname, "../corpus/clean");
const DEGRADED_DIR = path.resolve(import.meta.dirname, "../corpus/degraded");
const RESULTS_DIR = path.resolve(import.meta.dirname, "../results");

interface InvoiceFileGroup {
  invoiceId: string;
  imagePaths: string[]; // one entry, or several for a multi-page invoice, in page order
  mimeType: string;
}

async function groupFiles(dir: string, ext: string, mimeType: string): Promise<InvoiceFileGroup[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(`.${ext}`));
  const groups = new Map<string, string[]>();

  for (const file of files) {
    // "millbrook-dairy-3007.p1.jpg" -> invoiceId "millbrook-dairy-3007", page "p1"
    // "nova-foods-8891.jpg" -> invoiceId "nova-foods-8891", no page marker
    const withoutExt = file.slice(0, -(ext.length + 1));
    const pageMatch = withoutExt.match(/^(.+)\.p(\d+)$/);
    const invoiceId = pageMatch ? pageMatch[1]! : withoutExt;
    const existing = groups.get(invoiceId) ?? [];
    existing.push(file);
    groups.set(invoiceId, existing);
  }

  return Array.from(groups.entries()).map(([invoiceId, fileNames]) => ({
    invoiceId,
    imagePaths: fileNames.sort().map((f) => path.join(dir, f)), // "p1" < "p2" sorts correctly
    mimeType,
  }));
}

async function runVariant(
  variant: "clean" | "degraded",
  dir: string,
  ext: string,
  mimeType: string,
  provider: ExtractionProvider
): Promise<void> {
  const groups = await groupFiles(dir, ext, mimeType);
  const outDir = path.join(RESULTS_DIR, provider.name, variant);
  await mkdir(outDir, { recursive: true });

  console.log(`\n--- ${provider.name} / ${variant} (${groups.length} invoices) ---`);

  for (const group of groups) {
    const buffers = await Promise.all(group.imagePaths.map((p) => readFile(p)));
    let result = await provider.extract(buffers, mimeType, group.invoiceId);

    if (result.error?.includes("RESOURCE_EXHAUSTED")) {
      const retryMatch = result.error.match(/retryDelay":"(\d+)s/);
      const waitMs = (retryMatch ? Number(retryMatch[1]) : 30) * 1000 + 2000;
      console.log(`  ${group.invoiceId}: rate limited, waiting ${Math.round(waitMs / 1000)}s then retrying`);
      await new Promise((r) => setTimeout(r, waitMs));
      result = await provider.extract(buffers, mimeType, group.invoiceId);
    } else if (result.error?.startsWith("malformed JSON")) {
      console.log(`  ${group.invoiceId}: retrying after malformed JSON`);
      result = await provider.extract(buffers, mimeType, group.invoiceId);
    }

    const status = result.error ? `ERROR: ${result.error}` : `ok (${result.lines?.length ?? 0} lines, ${result.latencyMs}ms)`;
    console.log(`  ${group.invoiceId}: ${status}`);

    await writeFile(path.join(outDir, `${group.invoiceId}.json`), JSON.stringify(result, null, 2), "utf-8");

    // Free tier is 5 requests/minute for this model — space calls well under that.
    await new Promise((r) => setTimeout(r, 13000));
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY not set. Add it to spikes/extraction/.env or export it before running.");
    process.exit(1);
  }

  const provider = createGeminiProvider(apiKey);

  await runVariant("clean", CLEAN_DIR, "png", "image/png", provider);
  await runVariant("degraded", DEGRADED_DIR, "jpg", "image/jpeg", provider);

  console.log(`\nDone. Results in ${RESULTS_DIR}/${provider.name}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
