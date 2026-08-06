import { describe, expect, it } from 'vitest';
import { detectDocumentFormat, MAX_DOCUMENT_UPLOAD_BYTES, validateDocumentUpload } from './document-verification';

const PDF_HEADER = Buffer.from('%PDF-1.4\n%%EOF');
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

describe('detectDocumentFormat', () => {
  it('detects a real PDF signature', () => {
    expect(detectDocumentFormat(PDF_HEADER)).toBe('pdf');
  });

  it('detects a real JPEG signature (a phone photo of an invoice)', () => {
    expect(detectDocumentFormat(JPEG_HEADER)).toBe('jpeg');
  });

  it('detects a real PNG signature', () => {
    expect(detectDocumentFormat(PNG_HEADER)).toBe('png');
  });

  it('returns null for content whose bytes match no supported document signature', () => {
    expect(detectDocumentFormat(Buffer.from('this is plain text, not a document'))).toBeNull();
  });

  it('returns null for a ZIP-based format (e.g. an XLSX/DOCX masquerading as a PDF)', () => {
    const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    expect(detectDocumentFormat(zipHeader)).toBeNull();
  });

  it('returns null for a truncated/empty buffer', () => {
    expect(detectDocumentFormat(Buffer.alloc(0))).toBeNull();
  });
});

describe('validateDocumentUpload', () => {
  it('accepts a real PDF under the size cap', () => {
    expect(validateDocumentUpload(PDF_HEADER)).toEqual({ valid: true, format: 'pdf' });
  });

  it('accepts a real JPEG under the size cap', () => {
    expect(validateDocumentUpload(JPEG_HEADER)).toEqual({ valid: true, format: 'jpeg' });
  });

  it('rejects content whose bytes do not match any supported format, regardless of claimed type', () => {
    const result = validateDocumentUpload(Buffer.from('not a real document'));
    expect(result).toEqual({ valid: false, reason: 'UNSUPPORTED_FORMAT' });
  });

  it('rejects a real signature that exceeds the size cap', () => {
    const oversized = Buffer.concat([PDF_HEADER, Buffer.alloc(MAX_DOCUMENT_UPLOAD_BYTES)]);
    const result = validateDocumentUpload(oversized);
    expect(result).toEqual({ valid: false, reason: 'TOO_LARGE' });
  });

  it('accepts content exactly at the size cap', () => {
    const exactSize = Buffer.concat([PDF_HEADER, Buffer.alloc(MAX_DOCUMENT_UPLOAD_BYTES - PDF_HEADER.length)]);
    expect(exactSize.length).toBe(MAX_DOCUMENT_UPLOAD_BYTES);
    expect(validateDocumentUpload(exactSize)).toEqual({ valid: true, format: 'pdf' });
  });
});
