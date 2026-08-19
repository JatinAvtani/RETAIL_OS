'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { Button, Card, ErrorNotice, Field, Input, LoadingState, PageHeader, Select } from '@/components/ui';

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

  // The form's selects are useless until units/categories arrive — gate the whole form on this
  // rather than flashing empty dropdowns that fill themselves a beat later.
  const [referenceLoading, setReferenceLoading] = useState(true);

  useEffect(() => {
    Promise.all([trpc.units.list.query(), trpc.categories.list.query()])
      .then(([u, c]) => {
        setUnits(u);
        setCategories(c);
        if (u.length > 0) setBaseUnitId(u[0]!.id);
      })
      .finally(() => setReferenceLoading(false));
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

  if (referenceLoading) {
    return (
      <>
        <PageHeader title="New product" description="The base unit is what stock is counted in." />
        <Card>
          <LoadingState />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="New product"
        description="The base unit is what stock is counted in."
      />

      <Card className="max-w-2xl p-6">
        <form onSubmit={handleSubmit} className="space-y-5">
          {error && <ErrorNotice>{error}</ErrorNotice>}

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="SKU" hint="Your own code for this item.">
              <Input type="text" value={sku} onChange={(e) => setSku(e.target.value)} required placeholder="FLR-001" />
            </Field>

            <Field label="Name">
              <Input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="Flour, type 00"
              />
            </Field>

            <Field label="Base unit" hint="Stock and recipes are measured in this.">
              <Select value={baseUnitId} onChange={(e) => setBaseUnitId(e.target.value)} required>
                {units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.code}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Type">
              <Select
                value={type}
                onChange={(e) => setType(e.target.value as (typeof PRODUCT_TYPES)[number])}
              >
                {PRODUCT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.toLowerCase()}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Category"
              hint={
                <>
                  Optional.{' '}
                  <Link href="/categories" className="font-medium text-accent hover:underline">
                    Manage categories
                  </Link>
                </>
              }
            >
              <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">None</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <label className="flex items-center gap-2.5 text-sm text-content">
            <input
              type="checkbox"
              checked={isPerishable}
              onChange={(e) => setIsPerishable(e.target.checked)}
              className="size-4 rounded border-border-strong accent-accent"
            />
            Perishable — track expiry dates and use first-expiry-first-out
          </label>

          <div className="flex items-center gap-2 border-t border-border pt-5">
            <Button type="submit" variant="primary" disabled={submitting || !baseUnitId}>
              {submitting ? 'Creating…' : 'Create product'}
            </Button>
            <Link href="/products">
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </Link>
          </div>
        </form>
      </Card>
    </>
  );
}
