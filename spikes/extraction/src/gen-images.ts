import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { fixtures } from "./fixtures.js";
import { renderInvoiceHtml } from "./templates.js";

// Renders each fixture's HTML straight to PNG(s) — one image per invoice,
// or one per page for the multi-page fixture, split at its forced
// page-break-before. This is what the extraction providers actually read;
// PDFs in corpus/clean/ are kept as a secondary artifact for visual review.

const OUT_DIR = path.resolve(import.meta.dirname, "../corpus/clean");
const VIEWPORT_WIDTH = 794; // A4 @ 96dpi

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: VIEWPORT_WIDTH, height: 1123 } });

  for (const inv of fixtures) {
    const html = renderInvoiceHtml(inv);
    await page.setContent(html, { waitUntil: "networkidle" });

    const breakEl = await page.$('[style*="page-break-before"]');
    if (breakEl) {
      const box = await breakEl.boundingBox();
      const docEl = await page.$(".doc");
      const fullBox = await docEl!.boundingBox();
      if (box && fullBox) {
        // page 1: everything above the break
        await page.setViewportSize({ width: VIEWPORT_WIDTH, height: Math.ceil(box.y) });
        await page.screenshot({ path: path.join(OUT_DIR, `${inv.file}.p1.png`) });
        // page 2: everything from the break down
        const remaining = Math.ceil(fullBox.y + fullBox.height - box.y);
        await page.setViewportSize({ width: VIEWPORT_WIDTH, height: remaining + 40 });
        await page.evaluate((offset) => window.scrollTo(0, offset), box.y);
        await page.screenshot({ path: path.join(OUT_DIR, `${inv.file}.p2.png`) });
        await page.evaluate(() => window.scrollTo(0, 0));
        console.log(`generated ${inv.file}.p1.png + .p2.png (multi-page)`);
        continue;
      }
    }

    const docEl = await page.$(".doc");
    const box = await docEl!.boundingBox();
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: Math.ceil((box?.height ?? 600) + (box?.y ?? 0) + 20) });
    await page.screenshot({ path: path.join(OUT_DIR, `${inv.file}.png`), fullPage: false });
    console.log(`generated ${inv.file}.png`);
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
