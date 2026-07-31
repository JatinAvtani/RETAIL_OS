// Phase 5 — error injection. Take known-correct ground truth, inject specific
// error classes, and measure which gates catch them. This is the headline
// metric for the spike when the extractor is a general vision model: gate
// catch rate matters more than raw extraction accuracy.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixtures } from "./fixtures.js";
import type { InvoiceGroundTruth } from "./types.js";
import { runAllGates, type GateInput, type HistoryEntry, type PriceHistory } from "./gates.js";

const RESULTS_DIR = path.resolve(import.meta.dirname, "../results/error-injection");

interface Injection {
  name: string;
  expectedGate: string; // substring match against GateResult.gate
  apply(inv: InvoiceGroundTruth): InvoiceGroundTruth;
}

function decimalShift(inv: InvoiceGroundTruth): InvoiceGroundTruth {
  const lines = [...inv.lines];
  const i = 0;
  const shifted = (Number(lines[i]!.unitPrice) * 10).toFixed(2);
  lines[i] = { ...lines[i]!, unitPrice: shifted };
  // lineTotal is left as originally computed — this is the point: price and
  // total now disagree, exactly as a real decimal-shift OCR error would produce.
  return { ...inv, lines };
}

function digitTransposition(inv: InvoiceGroundTruth): InvoiceGroundTruth {
  const lines = [...inv.lines];
  const i = 0;
  const qty = lines[i]!.quantity;
  // transpose digits if 2+ chars, else bump by an order of magnitude
  const transposed = qty.length >= 2 ? qty[1] + qty[0] + qty.slice(2) : String(Number(qty) * 10 + 1);
  lines[i] = { ...lines[i]!, quantity: transposed };
  return { ...inv, lines };
}

function droppedLine(inv: InvoiceGroundTruth): InvoiceGroundTruth {
  const lines = inv.lines.slice(1); // drop first line, leave subtotal/total as original (now inconsistent)
  return { ...inv, lines };
}

function duplicatedLine(inv: InvoiceGroundTruth): InvoiceGroundTruth {
  const lines = [...inv.lines, inv.lines[0]!]; // duplicate first line, totals now inconsistent
  return { ...inv, lines };
}

function wrongYear(inv: InvoiceGroundTruth): InvoiceGroundTruth {
  const [y, m, d] = inv.documentDate.split("-");
  const wrongY = String(Number(y) - 3); // 3 years old still within-range check would need >24mo; use future instead
  return { ...inv, documentDate: `${wrongY}-${m}-${d}` };
}

const injections: Injection[] = [
  { name: "decimal-shift", expectedGate: "priceSanity", apply: decimalShift },
  { name: "digit-transposition", expectedGate: "arithmetic", apply: digitTransposition },
  { name: "dropped-line", expectedGate: "document.total", apply: droppedLine },
  { name: "duplicated-line", expectedGate: "document.total", apply: duplicatedLine },
  { name: "wrong-year", expectedGate: "document.date", apply: wrongYear },
];

function toGateInput(inv: InvoiceGroundTruth): GateInput {
  return {
    documentDate: inv.documentDate,
    subtotal: inv.subtotal,
    tax: inv.tax,
    discount: inv.discount,
    total: inv.total,
    lines: inv.lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
    supplier: inv.supplier,
    documentNumber: inv.documentNumber,
  };
}

function contentHashOf(inv: InvoiceGroundTruth): string {
  return `${inv.supplier}|${inv.documentNumber}|${inv.total}`;
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  // Seed price history from all clean fixtures so priceSanity has a baseline
  // to compare the decimal-shift injection against — otherwise the first
  // sighting of any price always passes ("establishing baseline").
  const priceHistory: PriceHistory = new Map();
  for (const inv of fixtures) {
    for (const l of inv.lines) {
      const key = `${inv.supplier}::${l.description}`;
      const arr = priceHistory.get(key) ?? [];
      arr.push(Number(l.unitPrice));
      priceHistory.set(key, arr);
    }
  }

  // Seed duplicate-detection history with every clean fixture except the one
  // under test, so "same invoice submitted twice" and "near-duplicate must
  // not false-positive" can both be checked.
  const allHistory: HistoryEntry[] = fixtures.map((inv) => ({
    supplier: inv.supplier,
    documentNumber: inv.documentNumber,
    contentHash: contentHashOf(inv),
  }));

  const report: Array<{
    fixture: string;
    injection: string;
    caught: boolean;
    catchingGates: string[];
    allFailedGates: string[];
  }> = [];

  for (const inv of fixtures) {
    for (const injection of injections) {
      const corrupted = injection.apply(inv);
      const gateInput = toGateInput(corrupted);
      const historyExcludingSelf = allHistory.filter((h) => h.documentNumber !== inv.documentNumber);

      const results = runAllGates(
        gateInput,
        contentHashOf(corrupted),
        historyExcludingSelf,
        priceHistory,
        corrupted.lines.map((l) => l.description)
      );

      const failed = results.filter((r) => !r.passed);
      const catching = failed.filter((r) => r.gate.includes(injection.expectedGate));

      report.push({
        fixture: inv.file,
        injection: injection.name,
        caught: catching.length > 0,
        catchingGates: catching.map((g) => `${g.gate}: ${g.detail}`),
        allFailedGates: failed.map((g) => g.gate),
      });
    }
  }

  // Same-invoice-submitted-twice: run one clean fixture's gates against
  // history that already contains itself.
  const dupTarget = fixtures[0]!;
  const dupInput = toGateInput(dupTarget);
  const dupResults = runAllGates(
    dupInput,
    contentHashOf(dupTarget),
    allHistory, // includes dupTarget itself
    priceHistory,
    dupTarget.lines.map((l) => l.description)
  );
  const dupGate = dupResults.find((r) => r.gate === "document.duplicate");
  report.push({
    fixture: dupTarget.file,
    injection: "resubmit-same-invoice",
    caught: dupGate ? !dupGate.passed : false,
    catchingGates: dupGate && !dupGate.passed ? [`${dupGate.gate}: ${dupGate.detail}`] : [],
    allFailedGates: dupResults.filter((r) => !r.passed).map((r) => r.gate),
  });

  // Specificity check: near-duplicate pair (nova-foods-8891 / 8892) must NOT
  // be flagged as a true duplicate by the duplicate gate.
  const novaA = fixtures.find((f) => f.file === "nova-foods-8891")!;
  const novaB = fixtures.find((f) => f.file === "nova-foods-8892")!;
  const novaBInput = toGateInput(novaB);
  const novaBResults = runAllGates(
    novaBInput,
    contentHashOf(novaB),
    [{ supplier: novaA.supplier, documentNumber: novaA.documentNumber, contentHash: contentHashOf(novaA) }],
    priceHistory,
    novaB.lines.map((l) => l.description)
  );
  const novaDupGate = novaBResults.find((r) => r.gate === "document.duplicate");
  report.push({
    fixture: "nova-foods-8892",
    injection: "near-duplicate-specificity (must NOT be flagged)",
    caught: novaDupGate ? novaDupGate.passed : false, // "caught" here means "correctly passed" — see summary logic below
    catchingGates: [],
    allFailedGates: novaDupGate && !novaDupGate.passed ? [novaDupGate.gate] : [],
  });

  await writeFile(path.join(RESULTS_DIR, "report.json"), JSON.stringify(report, null, 2), "utf-8");

  const trueInjections = report.filter((r) => r.injection !== "near-duplicate-specificity (must NOT be flagged)");
  const caughtCount = trueInjections.filter((r) => r.caught).length;
  const specificityRow = report.find((r) => r.injection.startsWith("near-duplicate-specificity"))!;

  console.log(`\nError injection: ${caughtCount}/${trueInjections.length} caught (${((caughtCount / trueInjections.length) * 100).toFixed(0)}%)`);
  console.log(`Near-duplicate specificity: ${specificityRow.caught ? "PASS (correctly not flagged)" : "FAIL (false positive)"}`);

  const byInjectionType = new Map<string, { total: number; caught: number }>();
  for (const r of trueInjections) {
    const entry = byInjectionType.get(r.injection) ?? { total: 0, caught: 0 };
    entry.total++;
    if (r.caught) entry.caught++;
    byInjectionType.set(r.injection, entry);
  }
  console.log("\nBy injection type:");
  for (const [name, { total, caught }] of byInjectionType) {
    console.log(`  ${name}: ${caught}/${total}`);
  }

  console.log(`\nFull report: ${path.join(RESULTS_DIR, "report.json")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
