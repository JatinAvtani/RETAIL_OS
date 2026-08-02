import { describe, expect, it } from 'vitest';
import { detectImageFormat, MAX_PRODUCT_IMAGE_BYTES, validateProductImage } from './image-verification';

const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP_HEADER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

describe('detectImageFormat', () => {
  it('detects a real JPEG signature', () => {
    expect(detectImageFormat(JPEG_HEADER)).toBe('jpeg');
  });

  it('detects a real PNG signature', () => {
    expect(detectImageFormat(PNG_HEADER)).toBe('png');
  });

  it('detects a real WebP signature (RIFF....WEBP)', () => {
    expect(detectImageFormat(WEBP_HEADER)).toBe('webp');
  });

  it('returns null for a PDF pretending to be an image via extension/content-type alone', () => {
    const pdfHeader = Buffer.from('%PDF-1.4\n');
    expect(detectImageFormat(pdfHeader)).toBeNull();
  });

  it('returns null for a truncated/empty buffer', () => {
    expect(detectImageFormat(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for a RIFF file that is not actually WebP (e.g. a WAV file)', () => {
    const wavHeader = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
    expect(detectImageFormat(wavHeader)).toBeNull();
  });
});

describe('validateProductImage', () => {
  it('accepts a real JPEG under the size cap', () => {
    const result = validateProductImage(JPEG_HEADER);
    expect(result).toEqual({ valid: true, format: 'jpeg' });
  });

  it('rejects content whose bytes do not match any supported image signature, regardless of claimed type', () => {
    const fakeImage = Buffer.from('this is not an image, just text pretending to be one');
    const result = validateProductImage(fakeImage);
    expect(result).toEqual({ valid: false, reason: 'UNSUPPORTED_FORMAT' });
  });

  it('rejects a real image signature that exceeds the size cap', () => {
    const oversized = Buffer.concat([PNG_HEADER, Buffer.alloc(MAX_PRODUCT_IMAGE_BYTES)]);
    const result = validateProductImage(oversized);
    expect(result).toEqual({ valid: false, reason: 'TOO_LARGE' });
  });

  it('accepts content exactly at the size cap', () => {
    const exactSize = Buffer.concat([
      PNG_HEADER,
      Buffer.alloc(MAX_PRODUCT_IMAGE_BYTES - PNG_HEADER.length),
    ]);
    expect(exactSize.length).toBe(MAX_PRODUCT_IMAGE_BYTES);
    const result = validateProductImage(exactSize);
    expect(result).toEqual({ valid: true, format: 'png' });
  });
});
