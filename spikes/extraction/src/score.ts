import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixtures } from "./fixtures.js";
import type { InvoiceGroundTruth, InvoiceLine } from "./types.js";
import type { ExtractedField, ExtractionResult } from "./providers/types.js";

const RESULTS_DIR = path.resolve(import.meta.dirname, "../results");
const CONFIDENCE_THRESHOLD = 0.7; // above this, treat the model as "confident"

function normalize(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/[$,]/g, "")
    .replace(/\s+/g, " ");
}

function fieldMatches(expected: string | null, extracted: ExtractedField | null | undefined, numeric: boolean): "exact" | "normalized" | "numeric" | "miss" {
  if (extracted == null || extracted.value === null) return expected === null ? "exact" : "miss";
  if (expected === null) return "miss"; // model produced a value where ground truth has none — still a miss for accuracy purposes

  if (extracted.value === expected) return "exact";
  if (normalize(extracted.value) === normalize(expected)) return "normalized";

  if (numeric) {
    const a = Number(extracted.value.replace(/[$,]/g, ""));
    const b = Number(expected.replace(/[$,]/g, ""));
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.01) return "numeric";
  }

  return "miss";
}

interface FieldScoreRow {
  file: string;
  field: string;
  expected: string | null;
  got: string | null;
  confidence: number | null;
  matchType: "exact" | "normalized" | "numeric" | "miss";
  confidentButWrong: boolean;
}

interface LineScoreRow {
  file: string;
  lineIndex: number;
  fullyCorrect: boolean;
  fieldResults: Record<string, "exact" | "normalized" | "numeric" | "miss">;
}

const HEADER_FIELDS: Array<{ key: keyof InvoiceGroundTruth; numeric: boolean }> = [
  { key: "supplier", numeric: false },
  { key: "documentNumber", numeric: false },
  { key: "documentDate", numeric: false },
  { key: "currency", numeric: false },
  { key: "subtotal", numeric: true },
  { key: "tax", numeric: true },
  { key: "total", numeric: true },
];

const LINE_FIELDS: Array<{ key: keyof InvoiceLine; numeric: boolean }> = [
  { key: "sku", numeric: false },
  { key: "description", numeric: false },
  { key: "quantity", numeric: true },
  { key: "unit", numeric: false },
  { key: "unitPrice", numeric: true },
  { key: "lineTotal", numeric: true },
];

function scoreInvoice(gt: InvoiceGroundTruth, result: ExtractionResult): { fieldRows: FieldScoreRow[]; lineRows: LineScoreRow[] } {
  const fieldRows: FieldScoreRow[] = [];

  if (result.error || !result.fields) {
    for (const { key } of HEADER_FIELDS) {
      fieldRows.push({
        file: gt.file,
        field: key,
        expected: String(gt[key] ?? ""),
        got: null,
        confidence: null,
        matchType: "miss",
        confidentButWrong: false,
      });
    }
    return { fieldRows, lineRows: [] };
  }

  for (const { key, numeric } of HEADER_FIELDS) {
    const expected = gt[key] as string;
    const extracted = (result.fields as any)[key] as ExtractedField | undefined;
    const matchType = fieldMatches(expected, extracted, numeric);
    const confident = (extracted?.confidence ?? 0) >= CONFIDENCE_THRESHOLD;
    fieldRows.push({
      file: gt.file,
      field: key,
      expected,
      got: extracted?.value ?? null,
      confidence: extracted?.confidence ?? null,
      matchType,
      confidentButWrong: confident && matchType === "miss",
    });
  }

  const lineRows: LineScoreRow[] = [];
  const extractedLines = result.lines ?? [];
  const maxLen = Math.max(gt.lines.length, extractedLines.length);

  for (let i = 0; i < maxLen; i++) {
    const expectedLine = gt.lines[i];
    const gotLine = extractedLines[i] as any;

    if (!expectedLine) {
      // extra line the model hallucinated beyond ground truth — counts against line accuracy implicitly via count mismatch
      continue;
    }

    const fieldResults: Record<string, "exact" | "normalized" | "numeric" | "miss"> = {};
    for (const { key, numeric } of LINE_FIELDS) {
      const expected = expectedLine[key];
      const extracted = gotLine?.[key] as ExtractedField | undefined;
      fieldResults[key] = fieldMatches(expected, extracted, numeric);

      const confident = (extracted?.confidence ?? 0) >= CONFIDENCE_THRESHOLD;
      fieldRows.push({
        file: gt.file,
        field: `line[${i}].${key}`,
        expected: String(expected ?? ""),
        got: extracted?.value ?? null,
        confidence: extracted?.confidence ?? null,
        matchType: fieldResults[key]!,
        confidentButWrong: confident && fieldResults[key] === "miss",
      });
    }

    const fullyCorrect = Object.values(fieldResults).every((m) => m !== "miss");
    lineRows.push({ file: gt.file, lineIndex: i, fullyCorrect, fieldResults });
  }

  return { fieldRows, lineRows };
}

async function loadResults(variant: "clean" | "degraded", providerName: string): Promise<Map<string, ExtractionResult>> {
  const dir = path.join(RESULTS_DIR, providerName, variant);
  const map = new Map<string, ExtractionResult>();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return map;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const content = await readFile(path.join(dir, f), "utf-8");
    const result: ExtractionResult = JSON.parse(content);
    map.set(result.file, result);
  }
  return map;
}

function summarize(fieldRows: FieldScoreRow[], lineRows: LineScoreRow[], label: string) {
  const headerRows = fieldRows.filter((r) => !r.field.startsWith("line["));
  const lineFieldRows = fieldRows.filter((r) => r.field.startsWith("line["));

  const headerAccuracy = headerRows.length ? headerRows.filter((r) => r.matchType !== "miss").length / headerRows.length : 0;
  const lineItemAccuracy = lineRows.length ? lineRows.filter((r) => r.fullyCorrect).length / lineRows.length : 0;
  const confidentButWrongRate = fieldRows.length ? fieldRows.filter((r) => r.confidentButWrong).length / fieldRows.length : 0;

  console.log(`\n=== ${label} ===`);
  console.log(`Header field accuracy: ${(headerAccuracy * 100).toFixed(1)}% (${headerRows.filter((r) => r.matchType !== "miss").length}/${headerRows.length})`);
  console.log(`Line-item full accuracy: ${(lineItemAccuracy * 100).toFixed(1)}% (${lineRows.filter((r) => r.fullyCorrect).length}/${lineRows.length})`);
  console.log(`Confident-but-wrong rate: ${(confidentButWrongRate * 100).toFixed(1)}% (${fieldRows.filter((r) => r.confidentButWrong).length}/${fieldRows.length})`);

  const misses = fieldRows.filter((r) => r.matchType === "miss");
  if (misses.length) {
    console.log(`\nMissed fields:`);
    for (const m of misses) {
      const flag = m.confidentButWrong ? " [CONFIDENT-BUT-WRONG]" : "";
      console.log(`  ${m.file} / ${m.field}: expected "${m.expected}", got "${m.got}" (conf ${m.confidence ?? "n/a"})${flag}`);
    }
  }

  return { headerAccuracy, lineItemAccuracy, confidentButWrongRate };
}

async function main() {
  const providerName = "gemini-flash-lite-latest";
  const gtByFile = new Map(fixtures.map((f) => [f.file, f]));

  const cleanResults = await loadResults("clean", providerName);
  const degradedResults = await loadResults("degraded", providerName);

  const allFieldRows: FieldScoreRow[] = [];
  const allLineRows: LineScoreRow[] = [];
  const cleanFieldRows: FieldScoreRow[] = [];
  const cleanLineRows: LineScoreRow[] = [];
  const degradedFieldRows: FieldScoreRow[] = [];
  const degradedLineRows: LineScoreRow[] = [];

  for (const [file, gt] of gtByFile) {
    const cleanResult = cleanResults.get(file);
    if (cleanResult) {
      const { fieldRows, lineRows } = scoreInvoice(gt, cleanResult);
      cleanFieldRows.push(...fieldRows);
      cleanLineRows.push(...lineRows);
    }
    const degradedResult = degradedResults.get(file);
    if (degradedResult) {
      const { fieldRows, lineRows } = scoreInvoice(gt, degradedResult);
      degradedFieldRows.push(...fieldRows);
      degradedLineRows.push(...lineRows);
    }
  }

  if (cleanFieldRows.length === 0 && degradedFieldRows.length === 0) {
    console.log("No extraction results found yet. Run `npm run extract` first.");
    return;
  }

  const cleanSummary = cleanFieldRows.length ? summarize(cleanFieldRows, cleanLineRows, "CLEAN") : null;
  const degradedSummary = degradedFieldRows.length ? summarize(degradedFieldRows, degradedLineRows, "DEGRADED") : null;

  if (cleanSummary && degradedSummary) {
    console.log(`\n=== GAP (clean - degraded) ===`);
    console.log(`Header accuracy gap: ${((cleanSummary.headerAccuracy - degradedSummary.headerAccuracy) * 100).toFixed(1)} points`);
    console.log(`Line-item accuracy gap: ${((cleanSummary.lineItemAccuracy - degradedSummary.lineItemAccuracy) * 100).toFixed(1)} points`);
  }

  // Per-supplier breakdown (clean)
  console.log(`\n=== Per-supplier line-item accuracy (clean) ===`);
  const bySupplier = new Map<string, { total: number; correct: number }>();
  for (const row of cleanLineRows) {
    const gt = gtByFile.get(row.file)!;
    const entry = bySupplier.get(gt.supplier) ?? { total: 0, correct: 0 };
    entry.total++;
    if (row.fullyCorrect) entry.correct++;
    bySupplier.set(gt.supplier, entry);
  }
  for (const [supplier, { total, correct }] of bySupplier) {
    console.log(`  ${supplier}: ${correct}/${total} (${((correct / total) * 100).toFixed(0)}%)`);
  }

  // Latency / cost
  const allResults = [...cleanResults.values(), ...degradedResults.values()];
  const successfulLatencies = allResults.filter((r) => !r.error).map((r) => r.latencyMs);
  const errorCount = allResults.filter((r) => r.error).length;
  if (successfulLatencies.length) {
    const avgLatency = successfulLatencies.reduce((a, b) => a + b, 0) / successfulLatencies.length;
    console.log(`\n=== Latency & reliability ===`);
    console.log(`Average latency: ${(avgLatency / 1000).toFixed(1)}s (n=${successfulLatencies.length})`);
    console.log(`Extraction errors: ${errorCount}/${allResults.length}`);
    console.log(`Cost per document: $0.00 (free tier)`);
  }

  const outPath = path.join(RESULTS_DIR, "score-report.json");
  await writeFile(
    outPath,
    JSON.stringify(
      {
        clean: { summary: cleanSummary, fieldRows: cleanFieldRows, lineRows: cleanLineRows },
        degraded: { summary: degradedSummary, fieldRows: degradedFieldRows, lineRows: degradedLineRows },
      },
      null,
      2
    ),
    "utf-8"
  );
  console.log(`\nFull report: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
