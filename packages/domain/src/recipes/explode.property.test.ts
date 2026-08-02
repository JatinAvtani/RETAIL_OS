import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Decimal } from 'decimal.js';
import { quantity } from '../primitives/quantity';
import {
  explodeRecipe,
  RecipeDepthExceededError,
  RecipeVersionNotFoundError,
  type Recipe,
  type RecipeComponent,
  type RecipeResolver,
} from './explode';

const ASOF = new Date('2026-06-01T00:00:00Z');

// Bounded, matching NUMERIC(19,6)-realistic quantities — same reasoning as every other property
// test file in this project: an unbounded generator produces values no finite-precision decimal
// arithmetic can meaningfully round-trip.
const positiveAmount = fc.integer({ min: 1, max: 1_000_000_000 }).map((micro) => micro / 1_000_000);
const wasteFactor = fc.integer({ min: 10_000, max: 20_000 }).map((micro) => micro / 10_000); // 1.0000 - 2.0000

const noopResolver: RecipeResolver = () => null;

const productComponent = (overrides: Partial<RecipeComponent> = {}): RecipeComponent => ({
  componentType: 'PRODUCT',
  productId: 'product-flour',
  quantity: new Decimal(1),
  unit: 'kg',
  wasteFactor: new Decimal(1),
  ...overrides,
} as RecipeComponent);

describe('explodeRecipe — quantity conservation and scaling (mandatory property tests)', () => {
  it('scaling is linear: exploding for 2x the yield produces exactly 2x every ingredient quantity', () => {
    fc.assert(
      fc.property(positiveAmount, positiveAmount, (yieldQty, componentQty) => {
        const recipe: Recipe = {
          recipeGroupId: 'sauce',
          yieldQuantity: new Decimal(yieldQty),
          yieldUnit: 'kg',
          components: [productComponent({ quantity: new Decimal(componentQty) })],
        };

        const at1x = explodeRecipe(recipe, quantity(yieldQty, 'kg'), ASOF, noopResolver);
        const at2x = explodeRecipe(recipe, quantity(new Decimal(yieldQty).times(2), 'kg'), ASOF, noopResolver);

        expect(at2x[0]?.quantity.toString()).toBe(at1x[0]?.quantity.times(2).toString());
      })
    );
  });

  it('scaling by any positive factor k multiplies every exploded quantity by exactly k', () => {
    fc.assert(
      fc.property(positiveAmount, positiveAmount, positiveAmount, (yieldQty, componentQty, k) => {
        const recipe: Recipe = {
          recipeGroupId: 'sauce',
          yieldQuantity: new Decimal(yieldQty),
          yieldUnit: 'kg',
          components: [productComponent({ quantity: new Decimal(componentQty) })],
        };

        const base = explodeRecipe(recipe, quantity(yieldQty, 'kg'), ASOF, noopResolver);
        const scaled = explodeRecipe(recipe, quantity(new Decimal(yieldQty).times(k), 'kg'), ASOF, noopResolver);

        const expected = base[0]!.quantity.times(k);
        expect(scaled[0]?.quantity.toString()).toBe(expected.toString());
      })
    );
  });

  it('quantity is conserved exactly: requesting the recipe\'s own yield returns each component\'s raw quantity (waste factor 1)', () => {
    fc.assert(
      fc.property(positiveAmount, positiveAmount, (yieldQty, componentQty) => {
        const recipe: Recipe = {
          recipeGroupId: 'sauce',
          yieldQuantity: new Decimal(yieldQty),
          yieldUnit: 'kg',
          components: [productComponent({ quantity: new Decimal(componentQty), wasteFactor: new Decimal(1) })],
        };

        const result = explodeRecipe(recipe, quantity(yieldQty, 'kg'), ASOF, noopResolver);

        expect(result[0]?.quantity.toString()).toBe(new Decimal(componentQty).toString());
      })
    );
  });
});

describe('explodeRecipe — waste factor', () => {
  it('a waste factor > 1 always increases the exploded quantity relative to factor 1', () => {
    fc.assert(
      fc.property(positiveAmount, positiveAmount, wasteFactor, (yieldQty, componentQty, waste) => {
        fc.pre(waste > 1);
        const withoutWaste: Recipe = {
          recipeGroupId: 'sauce',
          yieldQuantity: new Decimal(yieldQty),
          yieldUnit: 'kg',
          components: [productComponent({ quantity: new Decimal(componentQty), wasteFactor: new Decimal(1) })],
        };
        const withWaste: Recipe = {
          ...withoutWaste,
          components: [productComponent({ quantity: new Decimal(componentQty), wasteFactor: new Decimal(waste) })],
        };

        const base = explodeRecipe(withoutWaste, quantity(yieldQty, 'kg'), ASOF, noopResolver);
        const wasted = explodeRecipe(withWaste, quantity(yieldQty, 'kg'), ASOF, noopResolver);

        expect(wasted[0]!.quantity.greaterThan(base[0]!.quantity)).toBe(true);
      })
    );
  });

  it('waste factor exactly 1 leaves the quantity unchanged', () => {
    fc.assert(
      fc.property(positiveAmount, positiveAmount, (yieldQty, componentQty) => {
        const recipe: Recipe = {
          recipeGroupId: 'sauce',
          yieldQuantity: new Decimal(yieldQty),
          yieldUnit: 'kg',
          components: [productComponent({ quantity: new Decimal(componentQty), wasteFactor: new Decimal(1) })],
        };

        const result = explodeRecipe(recipe, quantity(yieldQty, 'kg'), ASOF, noopResolver);
        expect(result[0]?.quantity.toString()).toBe(new Decimal(componentQty).toString());
      })
    );
  });
});

describe('explodeRecipe — recursion, merging, and depth', () => {
  it('a 3-level nested recipe returns correct ingredient quantities (concrete anchor, not just properties)', () => {
    // Dish (yields 1 kg) needs 0.5 kg Sauce per kg dish.
    // Sauce (yields 1 kg) needs 0.2 kg Flour directly AND 0.3 kg Roux per kg sauce.
    // Roux (yields 1 kg) needs 0.4 kg Flour per kg roux.
    // Requesting 2 kg of Dish -> scale 2x -> needs 1.0 kg Sauce (0.5 * 2).
    // Sauce at 1.0 kg requested (= its own yield, scale 1x) needs 0.2 kg Flour directly and
    // 0.3 kg Roux requested. Roux at 0.3 kg requested (yield 1 kg, scale 0.3x) needs 0.4*0.3 =
    // 0.12 kg Flour. Total Flour = 0.2 + 0.12 = 0.32 kg, merged into one line.
    const roux: Recipe = {
      recipeGroupId: 'roux',
      yieldQuantity: new Decimal(1),
      yieldUnit: 'kg',
      components: [productComponent({ productId: 'flour', quantity: new Decimal('0.4') })],
    };
    const sauce: Recipe = {
      recipeGroupId: 'sauce',
      yieldQuantity: new Decimal(1),
      yieldUnit: 'kg',
      components: [
        productComponent({ productId: 'flour', quantity: new Decimal('0.2') }),
        { componentType: 'RECIPE', subRecipeGroupId: 'roux', quantity: new Decimal('0.3'), unit: 'kg', wasteFactor: new Decimal(1) },
      ],
    };
    const dish: Recipe = {
      recipeGroupId: 'dish',
      yieldQuantity: new Decimal(1),
      yieldUnit: 'kg',
      components: [
        { componentType: 'RECIPE', subRecipeGroupId: 'sauce', quantity: new Decimal('0.5'), unit: 'kg', wasteFactor: new Decimal(1) },
      ],
    };

    const resolver: RecipeResolver = (id) => (id === 'sauce' ? sauce : id === 'roux' ? roux : null);

    const result = explodeRecipe(dish, quantity(2, 'kg'), ASOF, resolver);

    expect(result).toHaveLength(1);
    expect(result[0]?.productId).toBe('flour');
    expect(result[0]?.quantity.toString()).toBe('0.32');
  });

  it('merges duplicate product lines from different branches into one summed line', () => {
    // Both a sub-recipe AND the top-level recipe consume the same product in the same unit.
    const subRecipe: Recipe = {
      recipeGroupId: 'sub',
      yieldQuantity: new Decimal(1),
      yieldUnit: 'kg',
      components: [productComponent({ productId: 'flour', quantity: new Decimal(1) })],
    };
    const topRecipe: Recipe = {
      recipeGroupId: 'top',
      yieldQuantity: new Decimal(1),
      yieldUnit: 'kg',
      components: [
        productComponent({ productId: 'flour', quantity: new Decimal(2) }),
        { componentType: 'RECIPE', subRecipeGroupId: 'sub', quantity: new Decimal(1), unit: 'kg', wasteFactor: new Decimal(1) },
      ],
    };
    const resolver: RecipeResolver = (id) => (id === 'sub' ? subRecipe : null);

    const result = explodeRecipe(topRecipe, quantity(1, 'kg'), ASOF, resolver);

    expect(result).toHaveLength(1);
    expect(result[0]?.quantity.toString()).toBe('3');
  });

  it('a cycle always causes RecipeDepthExceededError, at any starting depth', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 15 }), (startDepth) => {
        const selfReferencing: Recipe = {
          recipeGroupId: 'cyclic',
          yieldQuantity: new Decimal(1),
          yieldUnit: 'kg',
          components: [
            { componentType: 'RECIPE', subRecipeGroupId: 'cyclic', quantity: new Decimal(1), unit: 'kg', wasteFactor: new Decimal(1) },
          ],
        };
        const resolver: RecipeResolver = () => selfReferencing;

        expect(() => explodeRecipe(selfReferencing, quantity(1, 'kg'), ASOF, resolver, startDepth)).toThrow(
          RecipeDepthExceededError
        );
      })
    );
  });

  it('throws RecipeVersionNotFoundError, never silently skips, when a sub-recipe has no version valid asOf', () => {
    const recipe: Recipe = {
      recipeGroupId: 'top',
      yieldQuantity: new Decimal(1),
      yieldUnit: 'kg',
      components: [
        { componentType: 'RECIPE', subRecipeGroupId: 'missing', quantity: new Decimal(1), unit: 'kg', wasteFactor: new Decimal(1) },
      ],
    };

    expect(() => explodeRecipe(recipe, quantity(1, 'kg'), ASOF, noopResolver)).toThrow(RecipeVersionNotFoundError);
  });

  it('explosion at asOf = T uses the recipe version valid at T (versioning actually works)', () => {
    const versionJan: Recipe = {
      recipeGroupId: 'sauce',
      yieldQuantity: new Decimal(1),
      yieldUnit: 'kg',
      components: [productComponent({ productId: 'flour', quantity: new Decimal('0.2') })],
    };
    const versionMar: Recipe = {
      recipeGroupId: 'sauce',
      yieldQuantity: new Decimal(1),
      yieldUnit: 'kg',
      components: [productComponent({ productId: 'flour', quantity: new Decimal('0.5') })],
    };
    const resolver: RecipeResolver = (_id, asOf) =>
      asOf < new Date('2026-03-01T00:00:00Z') ? versionJan : versionMar;

    const top: Recipe = {
      recipeGroupId: 'top',
      yieldQuantity: new Decimal(1),
      yieldUnit: 'kg',
      components: [
        { componentType: 'RECIPE', subRecipeGroupId: 'sauce', quantity: new Decimal(1), unit: 'kg', wasteFactor: new Decimal(1) },
      ],
    };

    const beforeChange = explodeRecipe(top, quantity(1, 'kg'), new Date('2026-02-01T00:00:00Z'), resolver);
    const afterChange = explodeRecipe(top, quantity(1, 'kg'), new Date('2026-04-01T00:00:00Z'), resolver);

    expect(beforeChange[0]?.quantity.toString()).toBe('0.2');
    expect(afterChange[0]?.quantity.toString()).toBe('0.5');
  });

  it('rejects a requestedQty unit that does not match the recipe yield unit — no implicit mid-calculation conversion', () => {
    const recipe: Recipe = {
      recipeGroupId: 'sauce',
      yieldQuantity: new Decimal(1),
      yieldUnit: 'kg',
      components: [productComponent()],
    };

    expect(() => explodeRecipe(recipe, quantity(1, 'g'), ASOF, noopResolver)).toThrow(/yield unit/);
  });
});
