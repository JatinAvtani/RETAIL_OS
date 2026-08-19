/**
 * supplier documents (mostly invoices) arrive as either a PDF or a phone photo (JPEG/PNG)
 * — the exact two shapes the later milestone's extraction spike measured accuracy against. Same "verify actual
 * bytes, never trust client content-type" discipline as `image-verification.ts`/`csv-verification.ts`.
 *
 * XXE-hardening and PDF-bomb resource limits apply to PARSING a PDF's internal
 * structure, not to this magic-byte check — that hardening belongs to whatever eventually reads a
 * PDF's contents, not to upload-time verification, which never parses
 * anything. Malware/AV scanning is deliberately out of scope here too, matching earlier work's own
 * product-image precedent (no card, no budget for a real scanning service) — magic-byte type
 * verification + size cap are the real mitigations available under that constraint.
 */
export type SupportedDocumentFormat = 'pdf' | 'jpeg' | 'png';

const SIGNATURES: Record<SupportedDocumentFormat, (bytes: Buffer) => boolean> = {
  pdf: (bytes) =>
    bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d, // -
  jpeg: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  png: (bytes) =>
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a,
};

export const detectDocumentFormat = (bytes: Buffer): SupportedDocumentFormat | null => {
  for (const [format, matches] of Object.entries(SIGNATURES) as [SupportedDocumentFormat, (b: Buffer) => boolean][]) {
    if (matches(bytes)) return format;
  }
  return null;
};

export const MAX_DOCUMENT_UPLOAD_BYTES = 20 * 1024 * 1024;

export type DocumentValidationResult =
  | { valid: true; format: SupportedDocumentFormat }
  | { valid: false; reason: 'UNSUPPORTED_FORMAT' | 'TOO_LARGE' };

export const validateDocumentUpload = (bytes: Buffer): DocumentValidationResult => {
  if (bytes.length > MAX_DOCUMENT_UPLOAD_BYTES) {
    return { valid: false, reason: 'TOO_LARGE' };
  }
  const format = detectDocumentFormat(bytes);
  if (!format) {
    return { valid: false, reason: 'UNSUPPORTED_FORMAT' };
  }
  return { valid: true, format };
};

export const documentFormatToMimeType: Record<SupportedDocumentFormat, string> = {
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
  png: 'image/png',
};
