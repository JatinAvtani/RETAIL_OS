// Phase 4 — validation gates. These are deterministic code, not model output (I1
// equivalent for the spike). With a general vision model rather than a specialised
// document model, these gates carry more of the correctness load than raw
// extraction accuracy does — that shift in emphasis is the headline finding of
// this spike, not a footnote.

export interface GateResult {
  gate: string;
  passed: boolean;
  detail: string;
}

export interface GateInput {
  documentDate: string | null; // YYYY-MM-DD
  subtotal: string | null;
  tax: string | null;
  discount: string | null;
  total: string | null;
  lines: Array<{ quantity: string | null; unitPrice: string | null; lineTotal: string | null }>;
  supplier: string | null;
  documentNumber: string | null;
}

export interface HistoryEntry {
  supplier: string;
  documentNumber: string;
  contentHash: string;
}

// Trailing median unit price per supplier+description-ish key, built from
// whatever has been seen so far in the batch. In production this would be a
// real supplier-price history table; here it's an in-memory stand-in.
export type PriceHistory = Map<string, number[]>;

const TOLERANCE = 0.01;
const DOC_TOLERANCE = 0.02;

function toNumber(v: string | null): number | null {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function checkLineArithmetic(lines: GateInput["lines"]): GateResult[] {
  return lines.map((l, i) => {
    const qty = toNumber(l.quantity);
    const price = toNumber(l.unitPrice);
    const total = toNumber(l.lineTotal);

    if (qty === null || price === null || total === null) {
      return { gate: `line[${i}].arithmetic`, passed: false, detail: "one or more fields unparseable — cannot verify" };
    }

    const expected = Math.round(qty * price * 100) / 100;
    const diff = Math.abs(expected - total);
    return {
      gate: `line[${i}].arithmetic`,
      passed: diff <= TOLERANCE,
      detail: diff <= TOLERANCE
        ? `${qty} x ${price} = ${total} (ok)`
        : `${qty} x ${price} = ${expected}, but lineTotal is ${total} (diff ${diff.toFixed(2)})`,
    };
  });
}

export function checkDocumentTotal(input: GateInput): GateResult {
  const lineSum = input.lines.reduce((acc, l) => {
    const t = toNumber(l.lineTotal);
    return acc + (t ?? 0);
  }, 0);

  const tax = toNumber(input.tax) ?? 0;
  const discount = toNumber(input.discount) ?? 0;
  const total = toNumber(input.total);

  if (total === null) {
    return { gate: "document.total", passed: false, detail: "total field unparseable" };
  }

  const expected = Math.round((lineSum - discount + tax) * 100) / 100;
  const diff = Math.abs(expected - total);
  return {
    gate: "document.total",
    passed: diff <= DOC_TOLERANCE,
    detail: diff <= DOC_TOLERANCE
      ? `sum(lines)=${lineSum.toFixed(2)} - discount(${discount}) + tax(${tax}) = ${expected} (ok)`
      : `sum(lines)=${lineSum.toFixed(2)} - discount(${discount}) + tax(${tax}) = ${expected}, but total is ${total} (diff ${diff.toFixed(2)})`,
  };
}

export function checkDateSanity(documentDate: string | null, now: Date = new Date()): GateResult {
  if (!documentDate) {
    return { gate: "document.date", passed: false, detail: "date unparseable" };
  }
  const parsed = new Date(documentDate + "T00:00:00Z");
  if (Number.isNaN(parsed.getTime())) {
    return { gate: "document.date", passed: false, detail: `"${documentDate}" is not a valid date` };
  }

  const future = parsed.getTime() > now.getTime();
  const twentyFourMonthsAgo = new Date(now);
  twentyFourMonthsAgo.setMonth(twentyFourMonthsAgo.getMonth() - 24);
  const tooOld = parsed.getTime() < twentyFourMonthsAgo.getTime();

  if (future) return { gate: "document.date", passed: false, detail: `${documentDate} is in the future` };
  if (tooOld) return { gate: "document.date", passed: false, detail: `${documentDate} is more than 24 months old` };
  return { gate: "document.date", passed: true, detail: `${documentDate} is within range` };
}

export function checkDuplicate(
  supplier: string | null,
  documentNumber: string | null,
  contentHash: string,
  history: HistoryEntry[]
): GateResult {
  if (!supplier || !documentNumber) {
    return { gate: "document.duplicate", passed: true, detail: "supplier or documentNumber missing — cannot check, not flagged" };
  }

  const numberMatch = history.find((h) => h.supplier === supplier && h.documentNumber === documentNumber);
  const hashMatch = history.find((h) => h.contentHash === contentHash);

  if (numberMatch || hashMatch) {
    return {
      gate: "document.duplicate",
      passed: false,
      detail: numberMatch
        ? `same (supplier, documentNumber) seen before: ${supplier} / ${documentNumber}`
        : `identical content hash seen before`,
    };
  }
  return { gate: "document.duplicate", passed: true, detail: "no prior match" };
}

// Catches decimal-place errors — the most damaging failure class ($1.05 -> $10.50).
export function checkPriceSanity(
  lines: Array<{ description: string; unitPrice: string | null }>,
  supplier: string,
  history: PriceHistory
): GateResult[] {
  return lines.map((l, i) => {
    const price = toNumber(l.unitPrice);
    const key = `${supplier}::${l.description}`;
    const priorPrices = history.get(key) ?? [];

    if (price === null) {
      return { gate: `line[${i}].priceSanity`, passed: false, detail: "unitPrice unparseable" };
    }
    if (priorPrices.length === 0) {
      return { gate: `line[${i}].priceSanity`, passed: true, detail: "no price history yet — establishing baseline" };
    }

    const sorted = [...priorPrices].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const ratio = price / median;
    const withinBand = ratio <= 5 && ratio >= 1 / 5;

    return {
      gate: `line[${i}].priceSanity`,
      passed: withinBand,
      detail: withinBand
        ? `${price} within 5x of trailing median ${median.toFixed(2)}`
        : `${price} is ${ratio >= 1 ? ratio.toFixed(1) + "x" : (1 / ratio).toFixed(1) + "x below"} trailing median ${median.toFixed(2)} — possible decimal-place error`,
    };
  });
}

export function runAllGates(
  input: GateInput,
  contentHash: string,
  docHistory: HistoryEntry[],
  priceHistory: PriceHistory,
  lineDescriptions: string[],
  now: Date = new Date()
): GateResult[] {
  const results: GateResult[] = [
    ...checkLineArithmetic(input.lines),
    checkDocumentTotal(input),
    checkDateSanity(input.documentDate, now),
    checkDuplicate(input.supplier, input.documentNumber, contentHash, docHistory),
    ...checkPriceSanity(
      input.lines.map((l, i) => ({ description: lineDescriptions[i] ?? `line${i}`, unitPrice: l.unitPrice })),
      input.supplier ?? "unknown",
      priceHistory
    ),
  ];
  return results;
}
