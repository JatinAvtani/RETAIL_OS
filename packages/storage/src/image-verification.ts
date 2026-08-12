/**
 * Spec 14 §14.7: "type verified by magic bytes not extension." A client-supplied `Content-Type`
 * header (or a filename extension) is a claim, not a fact — this reads the first bytes of the
 * actual uploaded object and checks them against each format's real file signature. No image
 * library dependency needed; these signatures are stable, public constants.
 */
export type SupportedImageFormat = 'jpeg' | 'png' | 'webp';

const SIGNATURES: Record<SupportedImageFormat, (bytes: Buffer) => boolean> = {
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
  // RIFF....WEBP — the 4-byte "WEBP" marker sits at offset 8, after the RIFF size field.
  webp: (bytes) =>
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50,
};

/** Returns the detected format, or `null` if the bytes match none of the supported signatures. */
export const detectImageFormat = (bytes: Buffer): SupportedImageFormat | null => {
  for (const [format, matches] of Object.entries(SIGNATURES) as [SupportedImageFormat, (b: Buffer) => boolean][]) {
    if (matches(bytes)) return format;
  }
  return null;
};

export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;

export type ImageValidationResult =
  | { valid: true; format: SupportedImageFormat }
  | { valid: false; reason: 'UNSUPPORTED_FORMAT' | 'TOO_LARGE' };

export const validateProductImage = (bytes: Buffer): ImageValidationResult => {
  if (bytes.length > MAX_PRODUCT_IMAGE_BYTES) {
    return { valid: false, reason: 'TOO_LARGE' };
  }
  const format = detectImageFormat(bytes);
  if (!format) {
    return { valid: false, reason: 'UNSUPPORTED_FORMAT' };
  }
  return { valid: true, format };
};

/** 008-08: a damage-claim photo attached to a goods-receipt line — same real magic-byte detection as `validateProductImage`, its own size cap (a phone photo of physical damage, not a curated product shot). */
export const MAX_GOODS_RECEIPT_PHOTO_BYTES = 10 * 1024 * 1024;

export const validateGoodsReceiptPhoto = (bytes: Buffer): ImageValidationResult => {
  if (bytes.length > MAX_GOODS_RECEIPT_PHOTO_BYTES) {
    return { valid: false, reason: 'TOO_LARGE' };
  }
  const format = detectImageFormat(bytes);
  if (!format) {
    return { valid: false, reason: 'UNSUPPORTED_FORMAT' };
  }
  return { valid: true, format };
};
