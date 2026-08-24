import { describe, expect, it } from 'vitest';
import { detectCsvHeaders } from '../sales/csv-import.js';
import {
  parseProductCsvRows,
  parseSupplierCsvRows,
  parseRecipeCsvRows,
  type ProductCsvColumnMapping,
  type SupplierCsvColumnMapping,
  type RecipeCsvColumnMapping,
} from './catalog-csv-import.js';

const PRODUCT_MAPPING: ProductCsvColumnMapping = { sku: 'sku', name: 'name', unit: 'unit', type: 'type', category: 'category' };
const SUPPLIER_MAPPING: SupplierCsvColumnMapping = {
  name: 'name',
  paymentTerms: 'terms',
  leadTimeDaysContracted: 'lead_time',
  minOrderValue: 'min_order',
};
const RECIPE_MAPPING: RecipeCsvColumnMapping = {
  recipeName: 'recipe',
  yieldQuantity: 'yield_qty',
  yieldUnit: 'yield_unit',
  componentProductName: 'ingredient',
  componentQuantity: 'ingredient_qty',
  componentUnit: 'ingredient_unit',
  wasteFactor: 'waste_factor',
};

describe('parseProductCsvRows', () => {
  const headers = ['sku', 'name', 'unit', 'type', 'category'];

  it('parses a clean row', () => {
    const csv = 'sku,name,unit,type,category\nSKU-1,Flour T55,kg,INGREDIENT,Dry goods\n';
    const result = parseProductCsvRows(csv, headers, PRODUCT_MAPPING, []);
    expect(result.issues).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      sku: 'SKU-1',
      name: 'Flour T55',
      unitCode: 'kg',
      type: 'INGREDIENT',
      categoryName: 'Dry goods',
      possibleDuplicateOf: null,
    });
  });

  it('leaves categoryName null when the column is unmapped', () => {
    const csv = 'sku,name,unit,type\nSKU-1,Flour,kg,INGREDIENT\n';
    const result = parseProductCsvRows(csv, ['sku', 'name', 'unit', 'type'], { sku: 'sku', name: 'name', unit: 'unit', type: 'type' }, []);
    expect(result.rows[0]?.categoryName).toBeNull();
  });

  it('flags a row with an unrecognized unit as an issue, never guesses one', () => {
    const csv = 'sku,name,unit,type,category\nSKU-1,Flour,lbs,INGREDIENT,\n';
    const result = parseProductCsvRows(csv, headers, PRODUCT_MAPPING, []);
    expect(result.rows).toHaveLength(0);
    expect(result.issues).toEqual([{ rowIndex: 1, reason: expect.stringContaining('lbs') }]);
  });

  it('flags a row with an unrecognized type as an issue', () => {
    const csv = 'sku,name,unit,type,category\nSKU-1,Flour,kg,WIDGET,\n';
    const result = parseProductCsvRows(csv, headers, PRODUCT_MAPPING, []);
    expect(result.issues).toEqual([{ rowIndex: 1, reason: expect.stringContaining('WIDGET') }]);
  });

  it('flags a row missing a required field', () => {
    const csv = 'sku,name,unit,type,category\n,Flour,kg,INGREDIENT,\n';
    const result = parseProductCsvRows(csv, headers, PRODUCT_MAPPING, []);
    expect(result.issues).toEqual([{ rowIndex: 1, reason: 'missing a required field' }]);
  });

  it('flags a row as a possible duplicate of an EXISTING catalog product, but still parses it', () => {
    const csv = 'sku,name,unit,type,category\nSKU-2,T55 Flour,kg,INGREDIENT,\n';
    const result = parseProductCsvRows(csv, headers, PRODUCT_MAPPING, ['Flour T55']);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.possibleDuplicateOf).toBe('Flour T55');
  });

  it('flags a possible duplicate WITHIN the same file (two rows naming near-identical products)', () => {
    const csv = 'sku,name,unit,type,category\nSKU-1,Flour T55,kg,INGREDIENT,\nSKU-2,T55 Flour,kg,INGREDIENT,\n';
    const result = parseProductCsvRows(csv, headers, PRODUCT_MAPPING, []);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.possibleDuplicateOf).toBeNull();
    expect(result.rows[1]?.possibleDuplicateOf).toBe('Flour T55');
  });

  it('a genuinely distinct product name is NOT flagged as a duplicate', () => {
    const csv = 'sku,name,unit,type,category\nSKU-1,Whole Milk,l,INGREDIENT,\n';
    const result = parseProductCsvRows(csv, headers, PRODUCT_MAPPING, ['Flour T55']);
    expect(result.rows[0]?.possibleDuplicateOf).toBeNull();
  });

  it('throws when a REQUIRED field maps to a header absent from the file', () => {
    expect(() => parseProductCsvRows('a,b\n1,2\n', ['a', 'b'], PRODUCT_MAPPING, [])).toThrow(/does not exist/);
  });
});

describe('parseSupplierCsvRows', () => {
  const headers = ['name', 'terms', 'lead_time', 'min_order'];

  it('parses a clean row with every optional field', () => {
    const csv = 'name,terms,lead_time,min_order\nNova Foods,Net 30,5,$100.00\n';
    const result = parseSupplierCsvRows(csv, headers, SUPPLIER_MAPPING, []);
    expect(result.issues).toHaveLength(0);
    expect(result.rows[0]).toMatchObject({
      name: 'Nova Foods',
      paymentTerms: 'Net 30',
      leadTimeDaysContracted: 5,
      minOrderValue: '100.0000',
    });
  });

  it('parses a row with only the required name field', () => {
    const csv = 'name\nAurora Dairy\n';
    const result = parseSupplierCsvRows(csv, ['name'], { name: 'name' }, []);
    expect(result.rows[0]).toMatchObject({ name: 'Aurora Dairy', paymentTerms: null, leadTimeDaysContracted: null, minOrderValue: null });
  });

  it('flags a row with an unparseable lead time', () => {
    const csv = 'name,terms,lead_time,min_order\nNova Foods,Net 30,not-a-number,\n';
    const result = parseSupplierCsvRows(csv, headers, SUPPLIER_MAPPING, []);
    expect(result.rows).toHaveLength(0);
    expect(result.issues[0]?.reason).toContain('lead time');
  });

  it('flags a row missing the required name', () => {
    const csv = 'name,terms,lead_time,min_order\n,Net 30,5,\n';
    const result = parseSupplierCsvRows(csv, headers, SUPPLIER_MAPPING, []);
    expect(result.issues).toEqual([{ rowIndex: 1, reason: 'missing a required field' }]);
  });

  it('flags a possible duplicate of an existing supplier by near-identical name', () => {
    const csv = 'name\nNova Foods Ltd\n';
    const result = parseSupplierCsvRows(csv, ['name'], { name: 'name' }, ['Nova Foods']);
    expect(result.rows[0]?.possibleDuplicateOf).toBe('Nova Foods');
  });
});

describe('detectCsvHeaders reused directly for catalog imports (I2 — no second copy)', () => {
  it('detects headers and sample rows from a product CSV', () => {
    const csv = 'sku,name,unit,type\nSKU-1,Flour,kg,INGREDIENT\n';
    const detected = detectCsvHeaders(csv);
    expect(detected.headers).toEqual(['sku', 'name', 'unit', 'type']);
    expect(detected.sampleRows).toEqual([['SKU-1', 'Flour', 'kg', 'INGREDIENT']]);
  });
});

describe('parseRecipeCsvRows', () => {
  const headers = ['recipe', 'yield_qty', 'yield_unit', 'ingredient', 'ingredient_qty', 'ingredient_unit', 'waste_factor'];

  it('groups multiple component rows sharing the same recipe name/yield/yieldUnit into one group', () => {
    const csv =
      'recipe,yield_qty,yield_unit,ingredient,ingredient_qty,ingredient_unit,waste_factor\n' +
      'Croissant Dough,12,each,Flour T55,2,kg,\n' +
      'Croissant Dough,12,each,Butter,0.8,kg,1.05\n' +
      'Croissant Dough,12,each,Yeast,0.02,kg,\n';
    const result = parseRecipeCsvRows(csv, headers, RECIPE_MAPPING);
    expect(result.issues).toHaveLength(0);
    expect(result.groups).toHaveLength(1);
    const group = result.groups[0]!;
    expect(group.recipeName).toBe('Croissant Dough');
    expect(group.yieldQuantity).toBe('12.000000');
    expect(group.yieldUnitCode).toBe('each');
    expect(group.components).toHaveLength(3);
    expect(group.components[0]).toMatchObject({ productName: 'Flour T55', quantity: '2.000000', unitCode: 'kg', wasteFactor: null });
    expect(group.components[1]).toMatchObject({ productName: 'Butter', quantity: '0.800000', unitCode: 'kg', wasteFactor: '1.0500' });
  });

  it('two rows with the SAME recipe name but a DIFFERENT yield form two distinct groups', () => {
    const csv =
      'recipe,yield_qty,yield_unit,ingredient,ingredient_qty,ingredient_unit,waste_factor\n' +
      'Simple Syrup,1,l,Sugar,0.5,kg,\n' +
      'Simple Syrup,2,l,Sugar,1,kg,\n';
    const result = parseRecipeCsvRows(csv, headers, RECIPE_MAPPING);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]?.yieldQuantity).toBe('1.000000');
    expect(result.groups[1]?.yieldQuantity).toBe('2.000000');
  });

  it('preserves the order components appear in the file within a group', () => {
    const csv =
      'recipe,yield_qty,yield_unit,ingredient,ingredient_qty,ingredient_unit,waste_factor\n' +
      'Loaf,1,each,Water,0.5,l,\n' +
      'Loaf,1,each,Flour,1,kg,\n';
    const result = parseRecipeCsvRows(csv, headers, RECIPE_MAPPING);
    expect(result.groups[0]?.components.map((c) => c.productName)).toEqual(['Water', 'Flour']);
  });

  it('flags a row missing a required field', () => {
    const csv = 'recipe,yield_qty,yield_unit,ingredient,ingredient_qty,ingredient_unit,waste_factor\nLoaf,1,each,,1,kg,\n';
    const result = parseRecipeCsvRows(csv, headers, RECIPE_MAPPING);
    expect(result.groups).toHaveLength(0);
    expect(result.issues).toEqual([{ rowIndex: 1, reason: 'missing a required field' }]);
  });

  it('flags a row with an unrecognized component unit', () => {
    const csv = 'recipe,yield_qty,yield_unit,ingredient,ingredient_qty,ingredient_unit,waste_factor\nLoaf,1,each,Flour,1,lbs,\n';
    const result = parseRecipeCsvRows(csv, headers, RECIPE_MAPPING);
    expect(result.issues[0]?.reason).toContain('lbs');
  });

  it('flags a row with an unrecognized yield unit', () => {
    const csv = 'recipe,yield_qty,yield_unit,ingredient,ingredient_qty,ingredient_unit,waste_factor\nLoaf,1,servings,Flour,1,kg,\n';
    const result = parseRecipeCsvRows(csv, headers, RECIPE_MAPPING);
    expect(result.issues[0]?.reason).toContain('servings');
  });

  it('flags a row with a zero or negative yield quantity', () => {
    const csv = 'recipe,yield_qty,yield_unit,ingredient,ingredient_qty,ingredient_unit,waste_factor\nLoaf,0,each,Flour,1,kg,\n';
    const result = parseRecipeCsvRows(csv, headers, RECIPE_MAPPING);
    expect(result.issues[0]?.reason).toContain('yield quantity');
  });

  it('flags a row with a waste factor below 1', () => {
    const csv = 'recipe,yield_qty,yield_unit,ingredient,ingredient_qty,ingredient_unit,waste_factor\nLoaf,1,each,Flour,1,kg,0.9\n';
    const result = parseRecipeCsvRows(csv, headers, RECIPE_MAPPING);
    expect(result.issues[0]?.reason).toContain('waste factor');
  });

  it('a group with one bad row still contains its other clean components, and the bad row is reported separately', () => {
    const csv =
      'recipe,yield_qty,yield_unit,ingredient,ingredient_qty,ingredient_unit,waste_factor\n' +
      'Loaf,1,each,Flour,1,kg,\n' +
      'Loaf,1,each,BadIngredient,1,lbs,\n' +
      'Loaf,1,each,Water,0.5,l,\n';
    const result = parseRecipeCsvRows(csv, headers, RECIPE_MAPPING);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.components).toHaveLength(2);
    expect(result.groups[0]?.components.map((c) => c.productName)).toEqual(['Flour', 'Water']);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.reason).toContain('lbs');
  });

  it('throws when a required field maps to a header absent from the file', () => {
    expect(() => parseRecipeCsvRows('a,b\n1,2\n', ['a', 'b'], RECIPE_MAPPING)).toThrow(/does not exist/);
  });

  it('parses a single-column-equivalent minimal file with no waste_factor column mapped', () => {
    const noWasteFactorMapping: RecipeCsvColumnMapping = {
      recipeName: 'recipe',
      yieldQuantity: 'yield_qty',
      yieldUnit: 'yield_unit',
      componentProductName: 'ingredient',
      componentQuantity: 'ingredient_qty',
      componentUnit: 'ingredient_unit',
    };
    const csv = 'recipe,yield_qty,yield_unit,ingredient,ingredient_qty,ingredient_unit\nLoaf,1,each,Flour,1,kg\n';
    const result = parseRecipeCsvRows(csv, ['recipe', 'yield_qty', 'yield_unit', 'ingredient', 'ingredient_qty', 'ingredient_unit'], noWasteFactorMapping);
    expect(result.groups[0]?.components[0]?.wasteFactor).toBeNull();
  });
});
