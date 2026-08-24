/**
 * The Bengaluru café catalog: ingredients, categories, recipes, menu items, POS items.
 *
 * Everything here is authored as data, not generated randomly — a café's menu is a designed thing,
 * and random ingredient combinations would produce recipes that cost the wrong amount and read as
 * nonsense ("Masala chai: 400g paneer"). The RNG is used for VOLUME and VARIANCE downstream (sales,
 * deliveries, counts), never for what a product fundamentally is.
 *
 * NAMES ARE ENGLISH/TRANSLITERATED ONLY. The invoice PDF builder writes latin1 with a Courier base
 * font; Devanagari or Kannada characters would be silently mangled into garbage bytes in a document
 * that is supposed to be the provenance record for a cost figure.
 *
 * Prices are real INR wholesale/retail figures for Bengaluru, and `unitCost` is ALWAYS exactly
 * `packPrice / conversionToBase`. If those two disagree, the lot cost and the supplier price
 * history describe different realities and cost variance becomes meaningless.
 */

export type UnitCode = 'g' | 'ml' | 'each' | 'kg' | 'l';

export interface CatalogProduct {
  sku: string;
  name: string;
  /** Base unit the ledger tracks this in. */
  unitCode: UnitCode;
  category: string;
  storageLocation: 'Dry store' | 'Cold room' | 'Freezer' | 'Counter';
  perishable: boolean;
  /** What the supplier sells: pack price, human pack size, and how many BASE units one pack holds. */
  packPrice: string;
  packLabel: string;
  conversionToBase: string;
  /** packPrice / conversionToBase, exact. */
  unitCost: string;
  expiryInDays?: number;
  /** HSN code for the GST invoice. Real codes for the real commodity class. */
  hsn: string;
  /** GST rate in basis points (500 = 5%). Most food inputs are 5%; some are 12/18%. */
  gstBasisPoints: number;
  /**
   * When true this product is deliberately left with NO confirmed supplier price, so any recipe
   * using it computes as genuinely unknown rather than as a number. This is the I7 anchor — the
   * demo must show at least one honest "unknown" on screen, not a suspiciously complete dataset.
   */
  deliberatelyUnpriced?: boolean;
}

export const CATEGORIES = ['Dry goods', 'Dairy', 'Produce', 'Beverage', 'Packaging', 'Spices'] as const;

export const PRODUCTS: CatalogProduct[] = [
  // ---- Dry goods (flour, rice, pulses) ----
  { sku: 'ATA-WHT', name: 'Wheat flour (atta)', unitCode: 'g', category: 'Dry goods', storageLocation: 'Dry store', perishable: false, packPrice: '1420.0000', packLabel: '25 kg sack', conversionToBase: '25000', unitCost: '0.0568', hsn: '1101', gstBasisPoints: 500 },
  { sku: 'MAI-REF', name: 'Refined flour (maida)', unitCode: 'g', category: 'Dry goods', storageLocation: 'Dry store', perishable: false, packPrice: '1180.0000', packLabel: '25 kg sack', conversionToBase: '25000', unitCost: '0.0472', hsn: '1101', gstBasisPoints: 500 },
  { sku: 'RIC-SON', name: 'Sona masoori rice', unitCode: 'g', category: 'Dry goods', storageLocation: 'Dry store', perishable: false, packPrice: '2650.0000', packLabel: '25 kg sack', conversionToBase: '25000', unitCost: '0.1060', hsn: '1006', gstBasisPoints: 500 },
  { sku: 'RVA-IDL', name: 'Idli rava', unitCode: 'g', category: 'Dry goods', storageLocation: 'Dry store', perishable: false, packPrice: '620.0000', packLabel: '10 kg bag', conversionToBase: '10000', unitCost: '0.0620', hsn: '1103', gstBasisPoints: 500 },
  { sku: 'DAL-URD', name: 'Urad dal', unitCode: 'g', category: 'Dry goods', storageLocation: 'Dry store', perishable: false, packPrice: '1340.0000', packLabel: '10 kg bag', conversionToBase: '10000', unitCost: '0.1340', hsn: '0713', gstBasisPoints: 500 },
  { sku: 'DAL-TUR', name: 'Toor dal', unitCode: 'g', category: 'Dry goods', storageLocation: 'Dry store', perishable: false, packPrice: '1580.0000', packLabel: '10 kg bag', conversionToBase: '10000', unitCost: '0.1580', hsn: '0713', gstBasisPoints: 500 },
  { sku: 'SUJ-FIN', name: 'Semolina (sooji)', unitCode: 'g', category: 'Dry goods', storageLocation: 'Dry store', perishable: false, packPrice: '480.0000', packLabel: '10 kg bag', conversionToBase: '10000', unitCost: '0.0480', hsn: '1103', gstBasisPoints: 500 },
  { sku: 'SGR-REF', name: 'Refined sugar', unitCode: 'g', category: 'Dry goods', storageLocation: 'Dry store', perishable: false, packPrice: '5200.0000', packLabel: '100 kg', conversionToBase: '100000', unitCost: '0.0520', hsn: '1701', gstBasisPoints: 500 },
  { sku: 'JAG-ORG', name: 'Jaggery', unitCode: 'g', category: 'Dry goods', storageLocation: 'Dry store', perishable: false, packPrice: '650.0000', packLabel: '10 kg block', conversionToBase: '10000', unitCost: '0.0650', hsn: '1701', gstBasisPoints: 500 },
  { sku: 'OIL-SUN', name: 'Sunflower oil', unitCode: 'ml', category: 'Dry goods', storageLocation: 'Dry store', perishable: false, packPrice: '2340.0000', packLabel: '15 L tin', conversionToBase: '15000', unitCost: '0.1560', hsn: '1512', gstBasisPoints: 500 },
  { sku: 'GHE-PUR', name: 'Pure ghee', unitCode: 'g', category: 'Dairy', storageLocation: 'Dry store', perishable: false, packPrice: '3150.0000', packLabel: '5 kg tin', conversionToBase: '5000', unitCost: '0.6300', hsn: '0405', gstBasisPoints: 1200 },

  // ---- Dairy ----
  { sku: 'MLK-TON', name: 'Toned milk', unitCode: 'ml', category: 'Dairy', storageLocation: 'Cold room', perishable: true, packPrice: '672.0000', packLabel: '12 L crate', conversionToBase: '12000', unitCost: '0.0560', expiryInDays: 3, hsn: '0401', gstBasisPoints: 0 },
  { sku: 'CRD-SET', name: 'Set curd', unitCode: 'g', category: 'Dairy', storageLocation: 'Cold room', perishable: true, packPrice: '520.0000', packLabel: '10 kg tub', conversionToBase: '10000', unitCost: '0.0520', expiryInDays: 5, hsn: '0403', gstBasisPoints: 500 },
  { sku: 'PNR-FRS', name: 'Paneer', unitCode: 'g', category: 'Dairy', storageLocation: 'Cold room', perishable: true, packPrice: '1720.0000', packLabel: '5 kg block', conversionToBase: '5000', unitCost: '0.3440', expiryInDays: 6, hsn: '0406', gstBasisPoints: 500 },
  { sku: 'BTR-TBL', name: 'Table butter', unitCode: 'g', category: 'Dairy', storageLocation: 'Cold room', perishable: true, packPrice: '2450.0000', packLabel: '5 kg block', conversionToBase: '5000', unitCost: '0.4900', expiryInDays: 30, hsn: '0405', gstBasisPoints: 1200 },
  { sku: 'CHZ-MOZ', name: 'Mozzarella cheese', unitCode: 'g', category: 'Dairy', storageLocation: 'Cold room', perishable: true, packPrice: '1980.0000', packLabel: '5 kg block', conversionToBase: '5000', unitCost: '0.3960', expiryInDays: 21, hsn: '0406', gstBasisPoints: 1200 },
  { sku: 'CRM-FRS', name: 'Fresh cream', unitCode: 'ml', category: 'Dairy', storageLocation: 'Cold room', perishable: true, packPrice: '900.0000', packLabel: '5 L', conversionToBase: '5000', unitCost: '0.1800', expiryInDays: 7, hsn: '0401', gstBasisPoints: 1200 },

  // ---- Produce ----
  { sku: 'ONI-RED', name: 'Red onion', unitCode: 'g', category: 'Produce', storageLocation: 'Dry store', perishable: true, packPrice: '1150.0000', packLabel: '50 kg bag', conversionToBase: '50000', unitCost: '0.0230', expiryInDays: 20, hsn: '0703', gstBasisPoints: 0 },
  { sku: 'POT-TAB', name: 'Potato', unitCode: 'g', category: 'Produce', storageLocation: 'Dry store', perishable: true, packPrice: '1300.0000', packLabel: '50 kg bag', conversionToBase: '50000', unitCost: '0.0260', expiryInDays: 25, hsn: '0701', gstBasisPoints: 0 },
  { sku: 'TOM-HYB', name: 'Tomato', unitCode: 'g', category: 'Produce', storageLocation: 'Cold room', perishable: true, packPrice: '750.0000', packLabel: '25 kg crate', conversionToBase: '25000', unitCost: '0.0300', expiryInDays: 8, hsn: '0702', gstBasisPoints: 0 },
  { sku: 'CAP-GRN', name: 'Green capsicum', unitCode: 'g', category: 'Produce', storageLocation: 'Cold room', perishable: true, packPrice: '900.0000', packLabel: '10 kg crate', conversionToBase: '10000', unitCost: '0.0900', expiryInDays: 10, hsn: '0709', gstBasisPoints: 0 },
  { sku: 'CIL-FRS', name: 'Coriander leaves', unitCode: 'g', category: 'Produce', storageLocation: 'Cold room', perishable: true, packPrice: '360.0000', packLabel: '3 kg bundle', conversionToBase: '3000', unitCost: '0.1200', expiryInDays: 4, hsn: '0709', gstBasisPoints: 0 },
  { sku: 'CUR-LEF', name: 'Curry leaves', unitCode: 'g', category: 'Produce', storageLocation: 'Cold room', perishable: true, packPrice: '200.0000', packLabel: '2 kg bundle', conversionToBase: '2000', unitCost: '0.1000', expiryInDays: 5, hsn: '0709', gstBasisPoints: 0 },
  { sku: 'GIN-FRS', name: 'Ginger', unitCode: 'g', category: 'Produce', storageLocation: 'Cold room', perishable: true, packPrice: '840.0000', packLabel: '10 kg bag', conversionToBase: '10000', unitCost: '0.0840', expiryInDays: 14, hsn: '0910', gstBasisPoints: 500 },
  { sku: 'CHL-GRN', name: 'Green chilli', unitCode: 'g', category: 'Produce', storageLocation: 'Cold room', perishable: true, packPrice: '520.0000', packLabel: '10 kg bag', conversionToBase: '10000', unitCost: '0.0520', expiryInDays: 9, hsn: '0709', gstBasisPoints: 0 },
  { sku: 'BAN-LEF', name: 'Banana leaf', unitCode: 'each', category: 'Produce', storageLocation: 'Cold room', perishable: true, packPrice: '400.0000', packLabel: '100 leaves', conversionToBase: '100', unitCost: '4.0000', expiryInDays: 5, hsn: '0604', gstBasisPoints: 0 },

  // ---- Beverage ----
  { sku: 'CFE-FIL', name: 'Filter coffee powder', unitCode: 'g', category: 'Beverage', storageLocation: 'Dry store', perishable: false, packPrice: '2900.0000', packLabel: '5 kg pack', conversionToBase: '5000', unitCost: '0.5800', hsn: '0901', gstBasisPoints: 500 },
  { sku: 'TEA-DUS', name: 'Tea dust', unitCode: 'g', category: 'Beverage', storageLocation: 'Dry store', perishable: false, packPrice: '1350.0000', packLabel: '5 kg pack', conversionToBase: '5000', unitCost: '0.2700', hsn: '0902', gstBasisPoints: 500 },
  { sku: 'CFE-ARB', name: 'Arabica beans (espresso)', unitCode: 'g', category: 'Beverage', storageLocation: 'Dry store', perishable: false, packPrice: '3400.0000', packLabel: '4 kg pack', conversionToBase: '4000', unitCost: '0.8500', hsn: '0901', gstBasisPoints: 500 },
  { sku: 'LEM-FRS', name: 'Lemon', unitCode: 'each', category: 'Produce', storageLocation: 'Cold room', perishable: true, packPrice: '450.0000', packLabel: '150 count', conversionToBase: '150', unitCost: '3.0000', expiryInDays: 12, hsn: '0805', gstBasisPoints: 0 },

  // ---- Spices ----
  { sku: 'SLT-IOD', name: 'Iodised salt', unitCode: 'g', category: 'Spices', storageLocation: 'Dry store', perishable: false, packPrice: '260.0000', packLabel: '10 kg bag', conversionToBase: '10000', unitCost: '0.0260', hsn: '2501', gstBasisPoints: 0 },
  { sku: 'MSL-CHA', name: 'Chai masala', unitCode: 'g', category: 'Spices', storageLocation: 'Dry store', perishable: false, packPrice: '1100.0000', packLabel: '2 kg pack', conversionToBase: '2000', unitCost: '0.5500', hsn: '0910', gstBasisPoints: 500 },
  { sku: 'MSL-SAM', name: 'Sambar powder', unitCode: 'g', category: 'Spices', storageLocation: 'Dry store', perishable: false, packPrice: '1450.0000', packLabel: '5 kg pack', conversionToBase: '5000', unitCost: '0.2900', hsn: '0910', gstBasisPoints: 500 },
  { sku: 'MSL-GAR', name: 'Garam masala', unitCode: 'g', category: 'Spices', storageLocation: 'Dry store', perishable: false, packPrice: '1750.0000', packLabel: '2 kg pack', conversionToBase: '2000', unitCost: '0.8750', hsn: '0910', gstBasisPoints: 500 },
  { sku: 'TRM-POW', name: 'Turmeric powder', unitCode: 'g', category: 'Spices', storageLocation: 'Dry store', perishable: false, packPrice: '640.0000', packLabel: '2 kg pack', conversionToBase: '2000', unitCost: '0.3200', hsn: '0910', gstBasisPoints: 500 },
  { sku: 'MUS-SED', name: 'Mustard seeds', unitCode: 'g', category: 'Spices', storageLocation: 'Dry store', perishable: false, packPrice: '380.0000', packLabel: '2 kg pack', conversionToBase: '2000', unitCost: '0.1900', hsn: '1207', gstBasisPoints: 500 },

  // ---- Packaging ----
  { sku: 'CUP-PAP', name: 'Paper cup 150ml', unitCode: 'each', category: 'Packaging', storageLocation: 'Dry store', perishable: false, packPrice: '1250.0000', packLabel: '1000 cups', conversionToBase: '1000', unitCost: '1.2500', hsn: '4823', gstBasisPoints: 1800 },
  { sku: 'BOX-PRC', name: 'Parcel box (medium)', unitCode: 'each', category: 'Packaging', storageLocation: 'Dry store', perishable: false, packPrice: '1900.0000', packLabel: '500 boxes', conversionToBase: '500', unitCost: '3.8000', hsn: '4819', gstBasisPoints: 1800 },
  { sku: 'NAP-TIS', name: 'Paper napkins', unitCode: 'each', category: 'Packaging', storageLocation: 'Dry store', perishable: false, packPrice: '900.0000', packLabel: '2000 napkins', conversionToBase: '2000', unitCost: '0.4500', hsn: '4818', gstBasisPoints: 1800 },

  /**
   * PLANTED FINDING (I7 anchor): deliberately has NO supplier mapping and therefore no confirmed
   * price. Every recipe using it computes a genuinely unknown cost — the "unknown, never zero"
   * behaviour must be visible on screen, not just asserted in a test. Do not "fix" this by pricing
   * it; the demo is weaker without one honest gap.
   */
  { sku: 'VAN-EXT', name: 'Vanilla extract', unitCode: 'ml', category: 'Spices', storageLocation: 'Dry store', perishable: false, packPrice: '0.0000', packLabel: '1 L bottle', conversionToBase: '1000', unitCost: '0.0000', hsn: '1302', gstBasisPoints: 1800, deliberatelyUnpriced: true },
];

export interface RecipeComponentSpec {
  sku: string;
  /** Quantity in the product's BASE unit. */
  quantity: string;
}

export interface MenuItemSpec {
  name: string;
  /** How many sellable units one batch of the recipe yields. */
  yieldQuantity: string;
  yieldUnitCode: 'each' | 'l';
  /** Menu price in rupees, 4dp. */
  price: string;
  components: RecipeComponentSpec[];
  /**
   * The POS till's own name for this item. Deliberately NOT identical to the menu item name —
   * a real POS export never matches the kitchen's naming, and the fuzzy-matching screen only has
   * something to solve if these genuinely differ.
   */
  posName: string;
  /** Rough daily units at the FLAGSHIP outlet; other outlets scale from this. */
  flagshipPerDay: number;
}

export const MENU_ITEMS: MenuItemSpec[] = [
  { name: 'Filter coffee', posName: 'FILTER COFFEE', yieldQuantity: '1', yieldUnitCode: 'each', price: '35.0000', flagshipPerDay: 120,
    components: [{ sku: 'CFE-FIL', quantity: '14' }, { sku: 'MLK-TON', quantity: '110' }, { sku: 'SGR-REF', quantity: '8' }, { sku: 'CUP-PAP', quantity: '1' }] },
  { name: 'Masala chai', posName: 'MASALA CHAI', yieldQuantity: '1', yieldUnitCode: 'each', price: '25.0000', flagshipPerDay: 140,
    components: [{ sku: 'TEA-DUS', quantity: '6' }, { sku: 'MLK-TON', quantity: '100' }, { sku: 'SGR-REF', quantity: '9' }, { sku: 'MSL-CHA', quantity: '2' }, { sku: 'GIN-FRS', quantity: '2' }, { sku: 'CUP-PAP', quantity: '1' }] },
  { name: 'Cappuccino', posName: 'CAPPUCCINO REG', yieldQuantity: '1', yieldUnitCode: 'each', price: '140.0000', flagshipPerDay: 45,
    components: [{ sku: 'CFE-ARB', quantity: '18' }, { sku: 'MLK-TON', quantity: '150' }, { sku: 'CUP-PAP', quantity: '1' }] },
  { name: 'Masala dosa', posName: 'MASALA DOSA', yieldQuantity: '1', yieldUnitCode: 'each', price: '95.0000', flagshipPerDay: 70,
    components: [{ sku: 'RIC-SON', quantity: '90' }, { sku: 'DAL-URD', quantity: '30' }, { sku: 'POT-TAB', quantity: '110' }, { sku: 'ONI-RED', quantity: '35' }, { sku: 'OIL-SUN', quantity: '18' }, { sku: 'MUS-SED', quantity: '2' }, { sku: 'CUR-LEF', quantity: '2' }] },
  { name: 'Plain dosa', posName: 'DOSA PLAIN', yieldQuantity: '1', yieldUnitCode: 'each', price: '70.0000', flagshipPerDay: 40,
    components: [{ sku: 'RIC-SON', quantity: '90' }, { sku: 'DAL-URD', quantity: '30' }, { sku: 'OIL-SUN', quantity: '12' }] },
  { name: 'Idli (2 pc)', posName: 'IDLI 2PC', yieldQuantity: '1', yieldUnitCode: 'each', price: '55.0000', flagshipPerDay: 85,
    components: [{ sku: 'RVA-IDL', quantity: '70' }, { sku: 'DAL-URD', quantity: '25' }, { sku: 'MSL-SAM', quantity: '6' }, { sku: 'DAL-TUR', quantity: '18' }] },
  { name: 'Vada (2 pc)', posName: 'MEDU VADA 2PC', yieldQuantity: '1', yieldUnitCode: 'each', price: '60.0000', flagshipPerDay: 55,
    components: [{ sku: 'DAL-URD', quantity: '65' }, { sku: 'OIL-SUN', quantity: '25' }, { sku: 'CHL-GRN', quantity: '3' }, { sku: 'CUR-LEF', quantity: '2' }] },
  { name: 'Upma', posName: 'UPMA', yieldQuantity: '1', yieldUnitCode: 'each', price: '65.0000', flagshipPerDay: 30,
    components: [{ sku: 'SUJ-FIN', quantity: '90' }, { sku: 'ONI-RED', quantity: '30' }, { sku: 'OIL-SUN', quantity: '14' }, { sku: 'MUS-SED', quantity: '2' }, { sku: 'CUR-LEF', quantity: '2' }] },
  { name: 'Pongal', posName: 'VEN PONGAL', yieldQuantity: '1', yieldUnitCode: 'each', price: '75.0000', flagshipPerDay: 35,
    components: [{ sku: 'RIC-SON', quantity: '80' }, { sku: 'DAL-TUR', quantity: '35' }, { sku: 'GHE-PUR', quantity: '12' }, { sku: 'GIN-FRS', quantity: '3' }] },
  { name: 'Veg puff', posName: 'VEG PUFF', yieldQuantity: '1', yieldUnitCode: 'each', price: '40.0000', flagshipPerDay: 95,
    components: [{ sku: 'MAI-REF', quantity: '55' }, { sku: 'BTR-TBL', quantity: '22' }, { sku: 'POT-TAB', quantity: '45' }, { sku: 'ONI-RED', quantity: '20' }, { sku: 'MSL-GAR', quantity: '2' }] },
  { name: 'Paneer roll', posName: 'PANEER KATI ROLL', yieldQuantity: '1', yieldUnitCode: 'each', price: '160.0000', flagshipPerDay: 40,
    components: [{ sku: 'MAI-REF', quantity: '70' }, { sku: 'PNR-FRS', quantity: '85' }, { sku: 'ONI-RED', quantity: '25' }, { sku: 'CAP-GRN', quantity: '25' }, { sku: 'MSL-GAR', quantity: '3' }, { sku: 'OIL-SUN', quantity: '10' }, { sku: 'BOX-PRC', quantity: '1' }] },
  { name: 'Paneer butter masala', posName: 'PANEER BUTTER MSL', yieldQuantity: '1', yieldUnitCode: 'each', price: '210.0000', flagshipPerDay: 22,
    components: [{ sku: 'PNR-FRS', quantity: '150' }, { sku: 'TOM-HYB', quantity: '120' }, { sku: 'BTR-TBL', quantity: '30' }, { sku: 'CRM-FRS', quantity: '40' }, { sku: 'MSL-GAR', quantity: '4' }, { sku: 'ONI-RED', quantity: '40' }] },
  { name: 'Veg biryani', posName: 'VEG BIRYANI', yieldQuantity: '1', yieldUnitCode: 'each', price: '190.0000', flagshipPerDay: 28,
    components: [{ sku: 'RIC-SON', quantity: '180' }, { sku: 'POT-TAB', quantity: '60' }, { sku: 'CAP-GRN', quantity: '35' }, { sku: 'ONI-RED', quantity: '50' }, { sku: 'GHE-PUR', quantity: '15' }, { sku: 'MSL-GAR', quantity: '5' }, { sku: 'BOX-PRC', quantity: '1' }] },
  { name: 'Curd rice', posName: 'CURD RICE', yieldQuantity: '1', yieldUnitCode: 'each', price: '80.0000', flagshipPerDay: 25,
    components: [{ sku: 'RIC-SON', quantity: '120' }, { sku: 'CRD-SET', quantity: '150' }, { sku: 'MUS-SED', quantity: '2' }, { sku: 'CUR-LEF', quantity: '2' }] },
  { name: 'Sambar rice', posName: 'SAMBAR RICE', yieldQuantity: '1', yieldUnitCode: 'each', price: '85.0000', flagshipPerDay: 26,
    components: [{ sku: 'RIC-SON', quantity: '120' }, { sku: 'DAL-TUR', quantity: '45' }, { sku: 'MSL-SAM', quantity: '10' }, { sku: 'TOM-HYB', quantity: '40' }] },
  { name: 'Cheese sandwich', posName: 'GRILL CHEESE SNDWCH', yieldQuantity: '1', yieldUnitCode: 'each', price: '130.0000', flagshipPerDay: 30,
    components: [{ sku: 'MAI-REF', quantity: '80' }, { sku: 'CHZ-MOZ', quantity: '55' }, { sku: 'TOM-HYB', quantity: '30' }, { sku: 'BTR-TBL', quantity: '15' }, { sku: 'BOX-PRC', quantity: '1' }] },
  { name: 'Lemon soda', posName: 'LEMON SODA', yieldQuantity: '1', yieldUnitCode: 'each', price: '55.0000', flagshipPerDay: 38,
    components: [{ sku: 'LEM-FRS', quantity: '1' }, { sku: 'SGR-REF', quantity: '15' }, { sku: 'SLT-IOD', quantity: '1' }, { sku: 'CUP-PAP', quantity: '1' }] },
  { name: 'Badam milk', posName: 'BADAM MILK', yieldQuantity: '1', yieldUnitCode: 'each', price: '70.0000', flagshipPerDay: 20,
    components: [{ sku: 'MLK-TON', quantity: '180' }, { sku: 'SGR-REF', quantity: '14' }, { sku: 'CUP-PAP', quantity: '1' }] },
  {
    // PLANTED (I7): uses the deliberately unpriced vanilla extract, so this item's cost — and only
    // this item's — resolves to a genuine "unknown" on the recipe screen.
    name: 'Vanilla milkshake', posName: 'VANILLA SHAKE', yieldQuantity: '1', yieldUnitCode: 'each', price: '120.0000', flagshipPerDay: 18,
    components: [{ sku: 'MLK-TON', quantity: '200' }, { sku: 'SGR-REF', quantity: '18' }, { sku: 'VAN-EXT', quantity: '3' }, { sku: 'CUP-PAP', quantity: '1' }] },
  { name: 'Jaggery coffee', posName: 'JAGGERY COFFEE', yieldQuantity: '1', yieldUnitCode: 'each', price: '45.0000', flagshipPerDay: 24,
    components: [{ sku: 'CFE-FIL', quantity: '14' }, { sku: 'MLK-TON', quantity: '110' }, { sku: 'JAG-ORG', quantity: '12' }, { sku: 'CUP-PAP', quantity: '1' }] },
];

/**
 * Non-menu POS lines. These genuinely never map to a menu item (a packaging charge has no recipe),
 * and the seeder marks them IGNORED rather than UNMAPPED — a resolved decision, not an open gap.
 * Leaving them UNMAPPED would gate every margin figure to "unknown" forever.
 */
export const NON_MENU_POS_ITEMS = [
  { externalId: 'POS-9001', name: 'PARCEL CHARGE', price: '10.0000', flagshipPerDay: 30 },
  { externalId: 'POS-9002', name: 'GIFT CARD 500', price: '500.0000', flagshipPerDay: 1 },
] as const;
