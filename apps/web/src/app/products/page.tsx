'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';

type Product = Awaited<ReturnType<typeof trpc.products.list.query>>[number];

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    trpc.products.list
      .query(search ? { nameContains: search } : undefined)
      .then(setProducts)
      .catch(() => setError('Could not load products.'))
      .finally(() => setLoading(false));
  }, [search]);

  return (
    <main>
      <h1>Products</h1>
      <nav>
        <Link href="/products/new">New product</Link> · <Link href="/recipes">Recipes</Link> ·{' '}
        <Link href="/pos-items">Map POS items</Link>
      </nav>
      <input
        type="search"
        placeholder="Search by name"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {loading && <p>Loading...</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && products.length === 0 && <p>No products found.</p>}
      {!loading && !error && products.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Name</th>
              <th>Type</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id}>
                <td>{product.sku}</td>
                <td>{product.name}</td>
                <td>{product.type}</td>
                <td>
                  <Link href={`/products/${product.id}/edit`}>Edit</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
