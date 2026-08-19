import { describe, expect, it } from 'vitest';
import { chunkDocument } from './chunking';
import type { ExtractedField, ExtractedFields, ExtractedLine } from './extraction-types';

const f = (value: string | null): ExtractedField => ({ value, confidence: value ? 0.9 : null });
const emptyField: ExtractedField = { value: null, confidence: null };

const emptyFields: ExtractedFields = {
  supplier: emptyField,
  documentNumber: emptyField,
  documentDate: emptyField,
  currency: emptyField,
  subtotal: emptyField,
  tax: emptyField,
  discount: emptyField,
  total: emptyField,
};

const emptyLine: ExtractedLine = {
  sku: emptyField,
  description: emptyField,
  quantity: emptyField,
  unit: emptyField,
  unitPrice: emptyField,
  lineTotal: emptyField,
};

describe('chunkDocument', () => {
  it('produces one header chunk and one chunk per line item — never grouped, never split', () => {
    const fields: ExtractedFields = { ...emptyFields, supplier: f('Coastal Meats & Poultry'), documentNumber: f('INV-2024-8891'), total: f('450.00') };
    const lines: ExtractedLine[] = [
      { ...emptyLine, description: f('Chicken breast'), quantity: f('40'), unit: f('kg'), unitPrice: f('6.75'), lineTotal: f('270.00') },
      { ...emptyLine, description: f('Ground beef'), quantity: f('20'), unit: f('kg'), unitPrice: f('9.00'), lineTotal: f('180.00') },
    ];

    const chunks = chunkDocument(fields, lines);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ chunkKey: 'header', chunkType: 'header', order: 0 });
    expect(chunks[0]!.text).toContain('Coastal Meats & Poultry');
    expect(chunks[0]!.text).toContain('INV-2024-8891');
    expect(chunks[1]).toMatchObject({ chunkKey: 'line-0', chunkType: 'line_item', order: 1 });
    expect(chunks[1]!.text).toContain('Chicken breast');
    expect(chunks[1]!.text).toContain('40');
    expect(chunks[2]).toMatchObject({ chunkKey: 'line-1', chunkType: 'line_item', order: 2 });
    expect(chunks[2]!.text).toContain('Ground beef');
  });

  it('a single line item never gets split across multiple chunks — every real field lands in ONE chunk text', () => {
    const lines: ExtractedLine[] = [{ ...emptyLine, description: f('Flour T55'), sku: f('FLR-T55'), quantity: f('25'), unit: f('kg'), unitPrice: f('1.02'), lineTotal: f('25.50') }];

    const chunks = chunkDocument(emptyFields, lines);

    const lineChunks = chunks.filter((c) => c.chunkType === 'line_item');
    expect(lineChunks).toHaveLength(1);
    expect(lineChunks[0]!.text).toContain('Flour T55');
    expect(lineChunks[0]!.text).toContain('FLR-T55');
    expect(lineChunks[0]!.text).toContain('25');
    expect(lineChunks[0]!.text).toContain('1.02');
    expect(lineChunks[0]!.text).toContain('25.50');
  });

  it('a document with zero lines still produces a real header chunk — header-only data is not "nothing to chunk"', () => {
    const fields: ExtractedFields = { ...emptyFields, supplier: f('Acme Corp') };

    const chunks = chunkDocument(fields, []);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.chunkType).toBe('header');
  });

  it('a completely empty extraction (every field null) produces zero chunks, never an empty/meaningless one', () => {
    const chunks = chunkDocument(emptyFields, [emptyLine]);
    expect(chunks).toEqual([]);
  });

  it('a line with every field null is skipped, but does not break numbering for real lines after it', () => {
    const lines: ExtractedLine[] = [
      { ...emptyLine, description: f('Sugar') },
      emptyLine,
      { ...emptyLine, description: f('Salt') },
    ];

    const chunks = chunkDocument(emptyFields, lines);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.chunkKey).toBe('line-0');
    expect(chunks[0]!.text).toContain('Sugar');
    // The skipped middle line's index (1) is never reused as a chunkKey — chunkKey tracks the
    // line's own ARRAY index, not a compacted output position, so a future re-extraction that
    // fills in the skipped line's data doesn't collide with an already-assigned key.
    expect(chunks[1]!.chunkKey).toBe('line-2');
    expect(chunks[1]!.text).toContain('Salt');
    // `order` (display/citation position), unlike chunkKey, IS compacted — no gap for the skipped line.
    expect(chunks[1]!.order).toBe(1);
  });

  it('a null field value is omitted from chunk text entirely, never rendered as the literal string "null"', () => {
    const fields: ExtractedFields = { ...emptyFields, supplier: f('Acme'), documentNumber: emptyField };

    const chunks = chunkDocument(fields, []);

    expect(chunks[0]!.text).toBe('Supplier: Acme');
    expect(chunks[0]!.text).not.toContain('null');
  });
});
