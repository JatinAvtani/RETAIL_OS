// Runs the validation gates against real extracted results (not ground truth).
// Answers a different question than inject-errors.ts: does the gate suite
// correctly PASS real, mostly-correct model output without false-positiving,
// and does it catch the one real miss category we found (SKU-as-row-number)?

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runAllGates, type GateInput, type HistoryEntry, type PriceHistory } from "./gates.js";
import type { ExtractionResult } from "./providers/types.js";

const RESULTS_DIR = path.resolve(import.meta.dirname, "../results");

async function loadResults(variant: "clean" | "degraded", providerName: string): Promise<ExtractionResult[]> {
  const dir = path.join(RESULTS_DIR, providerName, variant);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out: ExtractionResult[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    out.push(JSON.parse(await readFile(path.join(dir, f), "utf-8")));
  }
  return out;
}

function toGateInput(result: ExtractionResult): GateInput | null {
  if (!result.fields) return null;
  const f = result.fields as any;
  return {
    documentDate: f.documentDate?.value ?? null,
    subtotal: f.subtotal?.value ?? null,
    tax: f.tax?.value ?? null,
    discount: f.discount?.value ?? null,
    total: f.total?.value ?? null,
    lines: (result.lines ?? []).map((l: any) => ({
      quantity: l.quantity?.value ?? null,
      unitPrice: l.unitPrice?.value ?? null,
      lineTotal: l.lineTotal?.value ?? null,
    })),
    supplier: f.supplier?.value ?? null,
    documentNumber: f.documentNumber?.value ?? null,
  };
}

function contentHashOf(result: ExtractionResult): string {
  const f = result.fields as any;
  return `${f?.supplier?.value}|${f?.documentNumber?.value}|${f?.total?.value}`;
}

async function main() {
  const providerName = "gemini-flash-lite-latest";
  const clean = await loadResults("clean", providerName);
  const degraded = await loadResults("degraded", providerName);
  const all = [...clean.map((r) => ({ r, variant: "clean" })), ...degraded.map((r) => ({ r, variant: "degraded" }))];

  if (all.length === 0) {
    console.log("No results found yet.");
    return;
  }

  const priceHistory: PriceHistory = new Map();
  const docHistory: HistoryEntry[] = [];

  const report: Array<{ file: string; variant: string; allPassed: boolean; failedGates: Array<{ gate: string; detail: string }> }> = [];

  for (const { r, variant } of all) {
    if (r.error || !r.fields) {
      report.push({ file: r.file, variant, allPassed: false, failedGates: [{ gate: "extraction", detail: r.error ?? "no fields" }] });
      continue;
    }
    const input = toGateInput(r)!;
    const lineDescriptions = (r.lines ?? []).map((l: any) => l.description?.value ?? "");
    // Fixtures are dated 2024 (see fixtures.ts) — evaluate date sanity relative to that era,
    // not real wall-clock time, so the 24-month-old check isn't just testing fixture staleness.
    const results = runAllGates(input, contentHashOf(r), docHistory, priceHistory, lineDescriptions, new Date("2024-07-01"));

    const failed = results.filter((g) => !g.passed);
    report.push({
      file: r.file,
      variant,
      allPassed: failed.length === 0,
      failedGates: failed.map((g) => ({ gate: g.gate, detail: g.detail })),
    });

    // seed history/price data for subsequent documents, as a real pipeline would
    docHistory.push({ supplier: input.supplier ?? "unknown", documentNumber: input.documentNumber ?? "unknown", contentHash: contentHashOf(r) });
    for (const l of r.lines ?? []) {
      const key = `${input.supplier}::${(l as any).description?.value}`;
      const price = Number((l as any).unitPrice?.value);
      if (Number.isFinite(price)) {
        const arr = priceHistory.get(key) ?? [];
        arr.push(price);
        priceHistory.set(key, arr);
      }
    }
  }

  await writeFile(path.join(RESULTS_DIR, "gate-check-report.json"), JSON.stringify(report, null, 2), "utf-8");

  console.log(`\n=== Gate check against REAL extracted results (${all.length} invoices) ===`);
  const passCount = report.filter((r) => r.allPassed).length;
  console.log(`All gates passed: ${passCount}/${report.length}`);
  for (const row of report) {
    if (!row.allPassed) {
      console.log(`\n  ${row.file} [${row.variant}]:`);
      for (const g of row.failedGates) {
        console.log(`    ${g.gate}: ${g.detail}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
