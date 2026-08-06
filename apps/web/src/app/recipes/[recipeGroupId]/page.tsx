'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorNotice,
  LoadingState,
  PageHeader,
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui';

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
  const [productNames, setProductNames] = useState<Map<string, string>>(new Map());
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

    // The cost breakdown returns productIds only; resolve them to real names for display so the
    // table doesn't show raw UUIDs. Purely presentational — no number is derived here.
    trpc.products.list
      .query()
      .then((products) => setProductNames(new Map(products.map((p) => [p.id, p.name]))))
      .catch(() => setProductNames(new Map()));
  }, [params.recipeGroupId]);

  if (loading) return <LoadingState />;
  if (error || !recipe) return <ErrorNotice>{error ?? 'Recipe not found.'}</ErrorNotice>;

  const costKnown = !costLoading && cost && cost.total !== 'unknown';

  return (
    <>
      <PageHeader
        title={recipe.name}
        description={`Yields ${recipe.yieldQuantity} per batch.`}
        actions={
          <Link href="/recipes">
            <Button variant="ghost">Back to recipes</Button>
          </Link>
        }
      />

      {/* The cost panel is the product's core claim made visible: a real, server-computed number
          from the metric catalog, or an explicit "unknown" — never a plausible-looking zero. */}
      <Card className="mb-6 overflow-hidden">
        <div className="flex flex-wrap items-end justify-between gap-4 bg-surface-sunken/50 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-content-subtle">
              Cost per batch
            </p>
            {costLoading && <p className="mt-2 text-sm text-content-muted">Computing…</p>}
            {!costLoading && !costKnown && (
              <p className="mt-1.5 text-3xl font-semibold tracking-tight text-content-subtle">Unknown</p>
            )}
            {costKnown && (
              <p className="tabular mt-1.5 text-3xl font-semibold tracking-tight text-content">
                <span className="mr-1 text-lg font-medium text-content-muted">
                  {cost!.total !== 'unknown' && cost!.total.currency}
                </span>
                {cost!.total !== 'unknown' && formatMoneyAmount(cost!.total.amount)}
              </p>
            )}
          </div>
          {!costLoading && !costKnown && (
            <p className="max-w-sm text-sm text-content-muted">
              At least one ingredient has no confirmed supplier price. We show{' '}
              <strong className="font-medium text-content">unknown</strong> rather than a zero — a
              guessed zero would silently overstate your margin.
            </p>
          )}
        </div>

        {!costLoading && cost && cost.lines.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Ingredient</Th>
                <Th align="right">Cost</Th>
              </tr>
            </thead>
            <tbody>
              {cost.lines.map((line) => (
                <Tr key={line.productId}>
                  <Td className="font-medium">
                    {productNames.get(line.productId) ?? (
                      <span className="text-content-subtle">{line.productId.slice(0, 8)}…</span>
                    )}
                  </Td>
                  <Td align="right">
                    {line.cost === 'unknown' ? (
                      <Badge tone="warning">Unknown</Badge>
                    ) : (
                      <span className="tabular">
                        {line.cost.currency} {formatMoneyAmount(line.cost.amount)}
                      </span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Components" />
        <Table>
          <thead>
            <tr>
              <Th>Type</Th>
              <Th align="right">Quantity</Th>
            </tr>
          </thead>
          <tbody>
            {recipe.components.map((component) => (
              <Tr key={component.id}>
                <Td>
                  <Badge tone={component.componentType === 'PRODUCT' ? 'neutral' : 'accent'}>
                    {component.componentType.toLowerCase().replace('_', ' ')}
                  </Badge>
                </Td>
                <Td align="right" className="tabular">
                  {component.quantity}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
