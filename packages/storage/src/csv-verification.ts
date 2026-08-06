/**
 * 006-10: same "verify actual bytes, never trust client content-type" discipline as
 * `image-verification.ts`, applied to a plain-text upload. A CSV has no magic-byte signature (it's
 * just text) — the real verification is: not a binary format masquerading as CSV (rejects an XLSX
 * upload, whose real signature is a ZIP local-file header, `PK\x03\x04`, at the exact byte offset a
 * misnamed `.csv` file would still carry), valid as UTF-8 text, and under the size cap.
 */
const ZIP_LOCAL_FILE_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

const looksLikeZipContainer = (bytes: Buffer): boolean =>
  bytes.length >= 4 && ZIP_LOCAL_FILE_SIGNATURE.every((byte, i) => bytes[i] === byte);

export const MAX_CSV_IMPORT_BYTES = 10 * 1024 * 1024;

export type CsvValidationResult =
  | { valid: true; text: string }
  | { valid: false; reason: 'TOO_LARGE' | 'NOT_UTF8_TEXT' | 'LOOKS_LIKE_BINARY_FORMAT' };

export const validateCsvUpload = (bytes: Buffer): CsvValidationResult => {
  if (bytes.length > MAX_CSV_IMPORT_BYTES) {
    return { valid: false, reason: 'TOO_LARGE' };
  }
  if (looksLikeZipContainer(bytes)) {
    // Almost certainly an .xlsx (or another ZIP-based Office format) — XLSX support is explicitly
    // out of scope for this task (confirmed with the user); reject with a clear reason rather than
    // attempting to decode ZIP bytes as text, which would produce garbage rows, not an error.
    return { valid: false, reason: 'LOOKS_LIKE_BINARY_FORMAT' };
  }
  const text = bytes.toString('utf8');
  // Buffer#toString('utf8') replaces invalid sequences with U+FFFD rather than throwing — checking
  // for the replacement character is how a genuinely non-UTF-8 file is caught here, since Node
  // gives no other signal.
  if (text.includes('�')) {
    return { valid: false, reason: 'NOT_UTF8_TEXT' };
  }
  return { valid: true, text };
};
