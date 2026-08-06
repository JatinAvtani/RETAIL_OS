import { describe, expect, it } from 'vitest';
import { MAX_CSV_IMPORT_BYTES, validateCsvUpload } from './csv-verification';

describe('validateCsvUpload', () => {
  it('accepts plain UTF-8 CSV text', () => {
    const bytes = Buffer.from('occurred_at,item,qty,price\n2026-08-01,Cappuccino,1,4.50\n', 'utf8');
    const result = validateCsvUpload(bytes);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.text).toContain('Cappuccino');
    }
  });

  it('rejects a file over the size cap', () => {
    const bytes = Buffer.alloc(MAX_CSV_IMPORT_BYTES + 1, 'a');
    const result = validateCsvUpload(bytes);
    expect(result).toEqual({ valid: false, reason: 'TOO_LARGE' });
  });

  it('rejects a real XLSX file (ZIP container signature) even with a .csv extension', () => {
    // Real ZIP local-file-header magic bytes — this is genuinely what an .xlsx file starts with.
    const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
    const result = validateCsvUpload(zipBytes);
    expect(result).toEqual({ valid: false, reason: 'LOOKS_LIKE_BINARY_FORMAT' });
  });

  it('rejects bytes that are not valid UTF-8 text', () => {
    // 0xFF 0xFE is not a valid UTF-8 sequence and isn't a ZIP signature either — Buffer#toString
    // replaces it with U+FFFD, which validateCsvUpload treats as a genuine encoding failure.
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    const result = validateCsvUpload(invalidUtf8);
    expect(result).toEqual({ valid: false, reason: 'NOT_UTF8_TEXT' });
  });

  it('accepts an empty file as valid text (an empty CSV is a real, if useless, case — header detection catches the actual "no data" problem)', () => {
    const result = validateCsvUpload(Buffer.from('', 'utf8'));
    expect(result.valid).toBe(true);
  });
});
