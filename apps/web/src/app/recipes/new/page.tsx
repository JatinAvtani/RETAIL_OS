'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  PageHeader,
  Select,
} from '@/components/ui';

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
    <>
      <PageHeader
        title="New recipe"
        description="Add each ingredient with the quantity used per batch — cost is computed from your confirmed supplier prices."
      />

      <form onSubmit={handleSubmit} className="max-w-3xl space-y-6">
        {error && <ErrorNotice>{error}</ErrorNotice>}

        <Card className="p-6">
          <div className="grid gap-5 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <Field label="Recipe name">
                <Input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="Sourdough loaf"
                />
              </Field>
            </div>

            <div className="sm:col-span-2">
              <Field label="Yield quantity" hint="How much one batch produces.">
                <Input
                  type="text"
                  value={yieldQuantity}
                  onChange={(e) => setYieldQuantity(e.target.value)}
                  required
                />
              </Field>
            </div>

            <Field label="Yield unit">
              <Select value={yieldUnitId} onChange={(e) => setYieldUnitId(e.target.value)} required>
                {units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.code}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Ingredients"
            actions={
              <Button type="button" onClick={addComponent} disabled={products.length === 0}>
                Add ingredient
              </Button>
            }
          />

          {components.length === 0 && (
            <EmptyState title="No ingredients yet" hint="Add at least one to create the recipe." />
          )}

          {components.length > 0 && (
            <div className="divide-y divide-border">
              {components.map((component, index) => (
                <div key={index} className="flex flex-wrap items-end gap-3 px-5 py-4">
                  <div className="min-w-48 flex-1">
                    <Field label="Ingredient">
                      <Select
                        value={component.productId}
                        onChange={(e) => updateComponent(index, { productId: e.target.value })}
                      >
                        {products.map((product) => (
                          <option key={product.id} value={product.id}>
                            {product.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>

                  <div className="w-28">
                    <Field label="Quantity">
                      <Input
                        type="text"
                        value={component.quantity}
                        onChange={(e) => updateComponent(index, { quantity: e.target.value })}
                      />
                    </Field>
                  </div>

                  <div className="w-24">
                    <Field label="Unit">
                      <Select
                        value={component.unitId}
                        onChange={(e) => updateComponent(index, { unitId: e.target.value })}
                      >
                        {units.map((unit) => (
                          <option key={unit.id} value={unit.id}>
                            {unit.code}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>

                  <Button type="button" variant="danger" onClick={() => removeComponent(index)}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="flex items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={submitting || components.length === 0 || !yieldUnitId}
          >
            {submitting ? 'Creating…' : 'Create recipe'}
          </Button>
          <Link href="/recipes">
            <Button type="button" variant="ghost">
              Cancel
            </Button>
          </Link>
        </div>
      </form>
    </>
  );
}
