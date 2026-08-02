'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';

type Unit = Awaited<ReturnType<typeof trpc.units.list.query>>[number];
type Category = Awaited<ReturnType<typeof trpc.categories.list.query>>[number];

const PRODUCT_TYPES = ['INGREDIENT', 'SELLABLE', 'BOTH'] as const;

export default function NewProductPage() {
  const router = useRouter();
  const [units, setUnits] = useState<Unit[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [baseUnitId, setBaseUnitId] = useState('');
  const [type, setType] = useState<(typeof PRODUCT_TYPES)[number]>('INGREDIENT');
  const [categoryId, setCategoryId] = useState('');
  const [isPerishable, setIsPerishable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([trpc.units.list.query(), trpc.categories.list.query()]).then(([u, c]) => {
      setUnits(u);
      setCategories(c);
      if (u.length > 0) setBaseUnitId(u[0]!.id);
    });
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const created = await trpc.products.create.mutate({
        sku,
        name,
        baseUnitId,
        type,
        ...(categoryId && { categoryId }),
        isPerishable,
      });
      router.push(`/products/${created.id}/edit`);
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Something went wrong. Try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main>
      <h1>New product</h1>
      <form onSubmit={handleSubmit}>
        <label>
          SKU
          <input type="text" value={sku} onChange={(e) => setSku(e.target.value)} required />
        </label>
        <label>
          Name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Base unit
          <select value={baseUnitId} onChange={(e) => setBaseUnitId(e.target.value)} required>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.code}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value as (typeof PRODUCT_TYPES)[number])}>
            {PRODUCT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Category (optional)
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
        <button type="submit" disabled={submitting || !baseUnitId}>
          {submitting ? 'Creating...' : 'Create product'}
        </button>
      </form>
    </main>
  );
}
