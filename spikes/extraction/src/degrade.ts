import { mkdir, readdir, copyFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// Phase 2 — degrade the clean corpus to approximate a real phone photo of a
// printed invoice. Mock invoices are clean by construction; skipping this
// step would report an upper bound and call it the answer.

const CLEAN_DIR = path.resolve(import.meta.dirname, "../corpus/clean");
const DEGRADED_DIR = path.resolve(import.meta.dirname, "../corpus/degraded");

async function degradeOne(srcPath: string, destPath: string): Promise<void> {
  const image = sharp(srcPath);
  const meta = await image.metadata();
  const width = meta.width ?? 800;
  const height = meta.height ?? 1000;

  // 2-5 degree rotation with white fill (simulates counter photo), then
  // a slight crop off one edge (careless framing), contrast reduction
  // (faded thermal print), light blur (poor focus), and re-encode as
  // low-quality JPEG (phone camera compression).
  const angle = 2 + Math.random() * 3;

  await image
    .rotate(angle, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .extract({
      left: Math.floor(width * 0.03),
      top: 0,
      width: Math.floor(width * 0.94),
      height: height,
    })
    .linear(0.6, 128 * 0.4) // contrast reduction toward mid-gray
    .blur(0.6)
    .jpeg({ quality: 40 })
    .toFile(destPath);
}

async function main() {
  await mkdir(DEGRADED_DIR, { recursive: true });

  const files = (await readdir(CLEAN_DIR)).filter((f) => f.endsWith(".png"));

  for (const file of files) {
    const srcPath = path.join(CLEAN_DIR, file);
    const destPath = path.join(DEGRADED_DIR, file.replace(/\.png$/, ".jpg"));
    await degradeOne(srcPath, destPath);
    console.log(`degraded ${file} -> ${path.basename(destPath)}`);
  }

  // ground truth is identical to the clean version — copy alongside so the
  // scorer can find it without cross-referencing directories.
  const gtFiles = (await readdir(CLEAN_DIR)).filter((f) => f.endsWith(".ground-truth.json"));
  for (const file of gtFiles) {
    await copyFile(path.join(CLEAN_DIR, file), path.join(DEGRADED_DIR, file));
  }

  console.log(`\n${files.length} images degraded into ${DEGRADED_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
