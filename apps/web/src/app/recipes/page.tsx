'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';

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
    <main>
      <h1>Recipes</h1>
      <nav>
        <Link href="/recipes/new">New recipe</Link> · <Link href="/products">Products</Link>
      </nav>
      {loading && <p>Loading...</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && recipes.length === 0 && <p>No recipes found.</p>}
      {!loading && !error && recipes.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Yield</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {recipes.map((recipe) => (
              <tr key={recipe.recipeGroupId}>
                <td>{recipe.name}</td>
                <td>
                  {recipe.yieldQuantity} {recipe.yieldUnitId}
                </td>
                <td>
                  <Link href={`/recipes/${recipe.recipeGroupId}`}>View</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
