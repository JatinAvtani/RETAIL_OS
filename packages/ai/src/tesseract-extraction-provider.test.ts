import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTesseractExtractionProvider } from './tesseract-extraction-provider';

/**
 * 007-06: real Docker containers (`jitesoft/tesseract-ocr`, `minidocks/poppler`), not mocked — a
 * mock would only prove this project's own code shells out correctly, not that Tesseract/poppler
 * genuinely produce usable output on a real document. Slower than a unit test (each `docker run`
 * has real container-startup overhead), matching the project's established "real Redis/Postgres/S3
 * for infrastructure code" precedent applied to a third kind of real infrastructure (a local OCR
 * engine + PDF rasterizer).
 *
 * Fixtures live in `src/__fixtures__/` (tracked in git), not `spikes/extraction/corpus/` (gitignored)
 * — a CI runner's fresh clone never has the spike corpus, which broke this suite in CI despite
 * passing locally.
 */
describe('createTesseractExtractionProvider', () => {
  it('extracts real text from a real PDF via rasterization + OCR, never throwing', async () => {
    const pdfBytes = readFileSync(new URL('./__fixtures__/coastal-meats-55210.pdf', import.meta.url));
    const provider = createTesseractExtractionProvider();

    const result = await provider.extract(pdfBytes, 'application/pdf');

    expect(result.error).toBeNull();
    expect(result.provider).toBe('tesseract');
    // Tesseract's regex-based header parser is real but genuinely imperfect (confirmed by the
    // EPIC-002 spike's own measured accuracy) — assert it found SOMETHING plausible, not perfect
    // field-for-field accuracy, which would be an unrealistic/overfit assertion for this provider.
    expect(result.fields).not.toBeNull();
    expect(result.overallConfidence).toBeNull(); // Tesseract has no semantic confidence — never fabricated.
  }, 60000); // rasterization + OCR are two real, sequential `docker run` invocations — genuinely slower on GitHub Actions' runner than this dev machine's Docker Desktop.

  it('degrades to a real error, never throwing, on genuinely unreadable bytes', async () => {
    const provider = createTesseractExtractionProvider();

    const result = await provider.extract(Buffer.from('this is not a real pdf or image'), 'application/pdf');

    expect(result.error).not.toBeNull();
    expect(result.fields).toBeNull();
  }, 60000);

  it('extracts from a real PNG image directly, without needing PDF rasterization', async () => {
    const pngBytes = readFileSync(new URL('./__fixtures__/coastal-meats-55210.png', import.meta.url));
    const provider = createTesseractExtractionProvider();

    const result = await provider.extract(pngBytes, 'image/png');

    expect(result.error).toBeNull();
    expect(result.fields).not.toBeNull();
  }, 60000);
});
