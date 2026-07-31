import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { fixtures } from "./fixtures.js";
import { renderInvoiceHtml } from "./templates.js";

const OUT_DIR = path.resolve(import.meta.dirname, "../corpus/clean");

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage();

  for (const inv of fixtures) {
    const html = renderInvoiceHtml(inv);
    await page.setContent(html, { waitUntil: "networkidle" });

    const pdfPath = path.join(OUT_DIR, `${inv.file}.pdf`);
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });

    const gtPath = path.join(OUT_DIR, `${inv.file}.ground-truth.json`);
    await writeFile(gtPath, JSON.stringify(inv, null, 2) + "\n", "utf-8");

    console.log(`generated ${inv.file}.pdf (+ ground truth)`);
  }

  await browser.close();
  console.log(`\n${fixtures.length} invoices written to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
