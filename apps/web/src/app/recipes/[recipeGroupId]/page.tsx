'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';

type RecipeDetail = Awaited<ReturnType<typeof trpc.recipes.get.query>>;
type RecipeCost = Awaited<ReturnType<typeof trpc.recipes.cost.query>>;

/**
 * `Money.amount` is branded as a `Decimal` server-side, but tRPC's JSON transport serializes it
 * to a plain string on the wire (Decimal has no custom toJSON, so JSON.stringify falls back to
 * its default numeric-string representation) — the client never actually receives a live Decimal
 * instance, regardless of what the inferred TS type claims. `Number(...)` here is purely for
 * display formatting (`.toFixed`), not a calculation — the real total was already computed
 * server-side by `computeRecipeCost` (I2); this function never sums or derives a number itself.
 */
const formatMoneyAmount = (amount: unknown): string => Number(amount).toFixed(2);

/**
 * "Live computed cost" (plan.md Phase 5): the cost panel is fetched fresh from `recipes.cost`
 * (packages/metrics' `computeRecipeCost`, the ONLY function allowed to sum these numbers, I2) on
 * load — a real, server-computed number, never estimated client-side. `total === 'unknown'`
 * renders as "Cost unknown," never `$0.00` (I7): a recipe missing even one confirmed supplier
 * price has a genuinely unknown cost, and a zero would silently overstate margin.
 */
export default function RecipeDetailPage() {
  const params = useParams<{ recipeGroupId: string }>();
  const [recipe, setRecipe] = useState<RecipeDetail | null>(null);
  const [cost, setCost] = useState<RecipeCost | null>(null);
  const [loading, setLoading] = useState(true);
  const [costLoading, setCostLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    trpc.recipes.get
      .query({ recipeGroupId: params.recipeGroupId })
      .then(setRecipe)
      .catch(() => setError('Could not load recipe.'))
      .finally(() => setLoading(false));

    trpc.recipes.cost
      .query({ recipeGroupId: params.recipeGroupId })
      .then(setCost)
      .catch(() => setCost(null))
      .finally(() => setCostLoading(false));
  }, [params.recipeGroupId]);

  if (loading) return <p>Loading...</p>;
  if (error || !recipe) return <p role="alert">{error ?? 'Recipe not found.'}</p>;

  return (
    <main>
      <h1>{recipe.name}</h1>
      <p>
        Yield: {recipe.yieldQuantity} ({recipe.yieldUnitId})
      </p>

      <section>
        <h2>Cost</h2>
        {costLoading && <p>Computing...</p>}
        {!costLoading && (!cost || cost.total === 'unknown') && (
          <p>Cost unknown — at least one component has no confirmed supplier price.</p>
        )}
        {!costLoading && cost && cost.total !== 'unknown' && (
          <p>
            {cost.total.currency} {formatMoneyAmount(cost.total.amount)}
          </p>
        )}
        {!costLoading && cost && cost.lines.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {cost.lines.map((line) => (
                <tr key={line.productId}>
                  <td>{line.productId}</td>
                  <td>{line.cost === 'unknown' ? 'Cost unknown' : `${line.cost.currency} ${formatMoneyAmount(line.cost.amount)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Components</h2>
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Quantity</th>
            </tr>
          </thead>
          <tbody>
            {recipe.components.map((component) => (
              <tr key={component.id}>
                <td>{component.componentType}</td>
                <td>{component.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
