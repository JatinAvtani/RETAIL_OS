'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { trimZeros } from '@/lib/format';
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SkeletonRows,
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui';

type RecipeSummary = Awaited<ReturnType<typeof trpc.recipes.list.query>>[number];

export default function RecipesPage() {
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    trpc.recipes.list
      .query()
      .then(setRecipes)
      .catch(() => setError('Could not load recipes.'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <PageHeader
        title="Recipes"
        description="What each menu item is made of."
        actions={
          <Link href="/recipes/new">
            <Button variant="primary">New recipe</Button>
          </Link>
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <Card>
        {loading && <SkeletonRows columns={4} />}
        {!loading && !error && recipes.length === 0 && (
          <EmptyState title="No recipes yet" hint="Create a recipe to see its computed cost." />
        )}
        {!loading && !error && recipes.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th align="right">Yield</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {recipes.map((recipe) => (
                <Tr key={recipe.recipeGroupId}>
                  <Td className="font-medium">{recipe.name}</Td>
                  <Td variant="numeric">
                    {trimZeros(recipe.yieldQuantity)}
                  </Td>
                  <Td variant="actions">
                    <Link
                      href={`/recipes/${recipe.recipeGroupId}`}
                      className="text-sm font-medium text-accent hover:underline"
                    >
                      View cost
                    </Link>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
