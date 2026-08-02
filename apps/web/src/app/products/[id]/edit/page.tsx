'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';

type Category = Awaited<ReturnType<typeof trpc.categories.list.query>>[number];

export default function EditProductPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [isPerishable, setIsPerishable] = useState(false);
  const [sku, setSku] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([trpc.products.get.query({ id: params.id }), trpc.categories.list.query()])
      .then(([product, cats]) => {
        setName(product.name);
        setSku(product.sku);
        setCategoryId(product.categoryId ?? '');
        setIsPerishable(product.isPerishable);
        setCategories(cats);
      })
      .catch(() => setError('Could not load product.'))
      .finally(() => setLoading(false));
  }, [params.id]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);

    try {
      await trpc.products.update.mutate({
        id: params.id,
        name,
        categoryId: categoryId || null,
        isPerishable,
      });
      setSaved(true);
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Something went wrong. Try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <p>Loading...</p>;

  return (
    <main>
      <h1>Edit product</h1>
      <p>SKU: {sku} (not editable)</p>
      <form onSubmit={handleSubmit}>
        <label>
          Name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Category
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">None</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={isPerishable} onChange={(e) => setIsPerishable(e.target.checked)} />
          Perishable
        </label>
        {error && <p role="alert">{error}</p>}
        {saved && <p>Saved.</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? 'Saving...' : 'Save'}
        </button>
      </form>
      <button type="button" onClick={() => router.push('/products')}>
        Back to products
      </button>
    </main>
  );
}
