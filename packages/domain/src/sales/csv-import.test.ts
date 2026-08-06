import { describe, expect, it } from 'vitest';
import { CsvParseError, detectCsvHeaders, parseCsvRows, type CsvColumnMapping } from './csv-import';

const SIMPLE_CSV = `occurred_at,item,qty,price\n2026-08-01,Cappuccino,2,4.50\n2026-08-02,Latte,1,5.25\n`;

describe('detectCsvHeaders', () => {
  it('detects headers, a comma delimiter, and sample rows from a simple file', () => {
    const result = detectCsvHeaders(SIMPLE_CSV);
    expect(result.headers).toEqual(['occurred_at', 'item', 'qty', 'price']);
    expect(result.delimiter).toBe(',');
    expect(result.sampleRows).toEqual([
      ['2026-08-01', 'Cappuccino', '2', '4.50'],
      ['2026-08-02', 'Latte', '1', '5.25'],
    ]);
  });

  it('strips a UTF-8 BOM before detecting headers', () => {
    const withBom = '\uFEFF' + SIMPLE_CSV;
    const result = detectCsvHeaders(withBom);
    expect(result.headers[0]).toBe('occurred_at'); // not the BOM prefixed onto it
  });

  it('detects a semicolon delimiter (a common European export convention)', () => {
    const semicolonCsv = 'occurred_at;item;qty;price\n2026-08-01;Cappuccino;2;4.50\n';
    const result = detectCsvHeaders(semicolonCsv);
    expect(result.delimiter).toBe(';');
    expect(result.headers).toEqual(['occurred_at', 'item', 'qty', 'price']);
  });

  it('throws CsvParseError on a genuinely empty file', () => {
    expect(() => detectCsvHeaders('')).toThrow(CsvParseError);
  });

  it('caps the sample at 20 rows even when the file has more', () => {
    const header = 'occurred_at,item,qty,price\n';
    const rows = Array.from({ length: 30 }, (_, i) => `2026-08-01,Item ${i},1,1.00\n`).join('');
    const result = detectCsvHeaders(header + rows);
    expect(result.sampleRows).toHaveLength(20);
  });
});

const FULL_MAPPING: CsvColumnMapping = {
  occurredAt: 'occurred_at',
  posItemName: 'item',
  quantity: 'qty',
  unitPrice: 'price',
};

describe('parseCsvRows', () => {
  const headers = ['occurred_at', 'item', 'qty', 'price'];

  it('parses every data row into the canonical shape, never touching the header row', () => {
    const { rows, issues } = parseCsvRows(SIMPLE_CSV, headers, FULL_MAPPING);
    expect(issues).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.posItemName).toBe('Cappuccino');
    expect(rows[0]!.quantity).toBe('2.000000');
    expect(rows[0]!.unitPrice).toBe('4.5000');
    // lineTotal defaults to quantity*unitPrice - discount when no lineTotal column is mapped
    expect(rows[0]!.lineTotal).toBe('9.0000');
    expect(rows[0]!.discount).toBe('0.0000');
    expect(rows[0]!.currency).toBe('USD');
  });

  it('produces a deterministic externalId — the same file parsed twice yields identical hashes', () => {
    const first = parseCsvRows(SIMPLE_CSV, headers, FULL_MAPPING);
    const second = parseCsvRows(SIMPLE_CSV, headers, FULL_MAPPING);
    expect(first.rows[0]!.externalId).toBe(second.rows[0]!.externalId);
    expect(first.rows[0]!.externalId).not.toBe(first.rows[1]!.externalId);
  });

  it('a different file (one changed cell) produces a different hash for that row only', () => {
    const edited = SIMPLE_CSV.replace('4.50', '4.75');
    const original = parseCsvRows(SIMPLE_CSV, headers, FULL_MAPPING);
    const changed = parseCsvRows(edited, headers, FULL_MAPPING);
    expect(changed.rows[0]!.externalId).not.toBe(original.rows[0]!.externalId);
    expect(changed.rows[1]!.externalId).toBe(original.rows[1]!.externalId); // untouched row
  });

  it('strips thousands separators and a leading currency symbol from numeric cells', () => {
    const csv = 'occurred_at,item,qty,price\n2026-08-01,Espresso,1,"$1,234.56"\n';
    const { rows, issues } = parseCsvRows(csv, headers, FULL_MAPPING);
    expect(issues).toEqual([]);
    expect(rows[0]!.unitPrice).toBe('1234.5600');
  });

  it('parses both ISO and US-style dates', () => {
    const csv = 'occurred_at,item,qty,price\n08/15/2026,Muffin,1,3.00\n';
    const { rows, issues } = parseCsvRows(csv, headers, FULL_MAPPING);
    expect(issues).toEqual([]);
    expect(rows[0]!.occurredAt.toISOString().slice(0, 10)).toBe('2026-08-15');
  });

  it('quarantines a row with an unparseable date as an issue, not a thrown error — the rest of the file still imports', () => {
    const csv = 'occurred_at,item,qty,price\nnot-a-date,Muffin,1,3.00\n2026-08-01,Bagel,1,2.00\n';
    const { rows, issues } = parseCsvRows(csv, headers, FULL_MAPPING);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.posItemName).toBe('Bagel');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.reason).toContain('unparseable date');
  });

  it('quarantines a row with an unparseable quantity as an issue', () => {
    const csv = 'occurred_at,item,qty,price\n2026-08-01,Muffin,abc,3.00\n';
    const { rows, issues } = parseCsvRows(csv, headers, FULL_MAPPING);
    expect(rows).toHaveLength(0);
    expect(issues[0]!.reason).toContain('unparseable quantity');
  });

  it('quarantines a row missing a required field entirely', () => {
    const csv = 'occurred_at,item,qty,price\n2026-08-01,,1,3.00\n';
    const { rows, issues } = parseCsvRows(csv, headers, FULL_MAPPING);
    expect(rows).toHaveLength(0);
    expect(issues[0]!.reason).toBe('missing a required field');
  });

  it('never guesses a value for a row it cannot confidently parse (I7) — the row is dropped from `rows`, not silently zeroed', () => {
    const csv = 'occurred_at,item,qty,price\n2026-08-01,Muffin,not-a-number,3.00\n';
    const { rows } = parseCsvRows(csv, headers, FULL_MAPPING);
    expect(rows.find((r) => r.posItemName === 'Muffin')).toBeUndefined();
  });

  it('trusts an explicit lineTotal column over quantity*unitPrice when both are mapped', () => {
    const csv = 'occurred_at,item,qty,price,total\n2026-08-01,Muffin,2,3.00,5.50\n'; // 2*3.00=6.00, but vendor says 5.50 (a discount already baked in)
    const withTotalMapping: CsvColumnMapping = { ...FULL_MAPPING, lineTotal: 'total' };
    const { rows } = parseCsvRows(csv, ['occurred_at', 'item', 'qty', 'price', 'total'], withTotalMapping);
    expect(rows[0]!.lineTotal).toBe('5.5000');
  });

  it('applies a mapped discount column to the computed lineTotal when no explicit lineTotal is mapped', () => {
    const csv = 'occurred_at,item,qty,price,disc\n2026-08-01,Muffin,2,3.00,1.00\n'; // 2*3.00 - 1.00 = 5.00
    const withDiscountMapping: CsvColumnMapping = { ...FULL_MAPPING, discount: 'disc' };
    const { rows } = parseCsvRows(csv, ['occurred_at', 'item', 'qty', 'price', 'disc'], withDiscountMapping);
    expect(rows[0]!.discount).toBe('1.0000');
    expect(rows[0]!.lineTotal).toBe('5.0000');
  });

  it('throws CsvParseError when the mapping references a header the file does not have', () => {
    const badMapping: CsvColumnMapping = { ...FULL_MAPPING, occurredAt: 'not_a_real_column' };
    expect(() => parseCsvRows(SIMPLE_CSV, headers, badMapping)).toThrow(CsvParseError);
  });

  it('reads an explicit currency column when mapped, defaulting to USD otherwise', () => {
    const csv = 'occurred_at,item,qty,price,cur\n2026-08-01,Muffin,1,3.00,eur\n';
    const withCurrencyMapping: CsvColumnMapping = { ...FULL_MAPPING, currency: 'cur' };
    const { rows } = parseCsvRows(csv, ['occurred_at', 'item', 'qty', 'price', 'cur'], withCurrencyMapping);
    expect(rows[0]!.currency).toBe('EUR'); // uppercased
  });
});
