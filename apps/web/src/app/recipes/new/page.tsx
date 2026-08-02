'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';

type Unit = Awaited<ReturnType<typeof trpc.units.list.query>>[number];
type Product = Awaited<ReturnType<typeof trpc.products.list.query>>[number];

type ComponentDraft = {
  productId: string;
  quantity: string;
  unitId: string;
};

export default function NewRecipePage() {
  const router = useRouter();
  const [units, setUnits] = useState<Unit[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [name, setName] = useState('');
  const [yieldQuantity, setYieldQuantity] = useState('1');
  const [yieldUnitId, setYieldUnitId] = useState('');
  const [components, setComponents] = useState<ComponentDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([trpc.units.list.query(), trpc.products.list.query()]).then(([u, p]) => {
      setUnits(u);
      setProducts(p);
      if (u.length > 0) setYieldUnitId(u[0]!.id);
    });
  }, []);

  const addComponent = () => {
    if (products.length === 0 || units.length === 0) return;
    setComponents((prev) => [...prev, { productId: products[0]!.id, quantity: '1', unitId: units[0]!.id }]);
  };

  const updateComponent = (index: number, patch: Partial<ComponentDraft>) => {
    setComponents((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const removeComponent = (index: number) => {
    setComponents((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const created = await trpc.recipes.create.mutate({
        name,
        yieldQuantity,
        yieldUnitId,
        components: components.map((c) => ({
          componentType: 'PRODUCT' as const,
          productId: c.productId,
          quantity: c.quantity,
          unitId: c.unitId,
        })),
      });
      router.push(`/recipes/${created.recipeGroupId}`);
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Something went wrong. Try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main>
      <h1>New recipe</h1>
      <form onSubmit={handleSubmit}>
        <label>
          Name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Yield quantity
          <input type="text" value={yieldQuantity} onChange={(e) => setYieldQuantity(e.target.value)} required />
        </label>
        <label>
          Yield unit
          <select value={yieldUnitId} onChange={(e) => setYieldUnitId(e.target.value)} required>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.code}
              </option>
            ))}
          </select>
        </label>

        <h2>Components</h2>
        {components.map((component, index) => (
          <div key={index}>
            <select
              value={component.productId}
              onChange={(e) => updateComponent(index, { productId: e.target.value })}
            >
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={component.quantity}
              onChange={(e) => updateComponent(index, { quantity: e.target.value })}
              placeholder="Quantity"
            />
            <select value={component.unitId} onChange={(e) => updateComponent(index, { unitId: e.target.value })}>
              {units.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.code}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => removeComponent(index)}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" onClick={addComponent} disabled={products.length === 0}>
          Add component
        </button>

        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={submitting || components.length === 0 || !yieldUnitId}>
          {submitting ? 'Creating...' : 'Create recipe'}
        </button>
      </form>
    </main>
  );
}
