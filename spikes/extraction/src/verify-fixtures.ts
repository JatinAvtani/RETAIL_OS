import { fixtures } from "./fixtures.js";

let failed = false;

for (const inv of fixtures) {
  const lineSum = inv.lines.reduce((acc, l) => acc + Number(l.lineTotal), 0);
  const computedLineSum = Math.round(lineSum * 100) / 100;

  for (const l of inv.lines) {
    const expected = Number(l.quantity) * Number(l.unitPrice);
    const rounded = Math.round(expected * 100) / 100;
    if (Math.abs(rounded - Number(l.lineTotal)) > 0.01) {
      console.error(`[${inv.file}] line arithmetic mismatch: ${l.description} — ${l.quantity} x ${l.unitPrice} = ${rounded}, got ${l.lineTotal}`);
      failed = true;
    }
  }

  const discount = inv.discount ? Number(inv.discount) : 0;
  if (Math.abs(computedLineSum - Number(inv.subtotal)) > 0.01) {
    console.error(`[${inv.file}] subtotal mismatch: sum(lines)=${computedLineSum}, subtotal=${inv.subtotal}`);
    failed = true;
  }

  const computedTotal = Math.round((Number(inv.subtotal) - discount + Number(inv.tax)) * 100) / 100;
  if (Math.abs(computedTotal - Number(inv.total)) > 0.01) {
    console.error(`[${inv.file}] total mismatch: subtotal(${inv.subtotal}) - discount(${discount}) + tax(${inv.tax}) = ${computedTotal}, got ${inv.total}`);
    failed = true;
  }
}

if (failed) {
  console.error("\nFixture arithmetic is inconsistent. Fix before generating the corpus.");
  process.exit(1);
} else {
  console.log(`All ${fixtures.length} fixtures pass arithmetic verification.`);
}
