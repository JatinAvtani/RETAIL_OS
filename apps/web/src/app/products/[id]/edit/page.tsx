'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';

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

  if (loading) return <LoadingState />;

  return (
    <>
      <PageHeader
        title={name || 'Edit product'}
        description="SKU and base unit can't be changed after creation."
        actions={
          <Link href="/products">
            <Button variant="ghost">Back to products</Button>
          </Link>
        }
      />

      <Card className="max-w-2xl p-6">
        <form onSubmit={handleSubmit} className="space-y-5">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          {saved && (
            <div className="rounded-card border border-positive/30 bg-positive-soft px-4 py-3 text-sm text-positive">
              Changes saved.
            </div>
          )}

          <div className="flex items-center gap-2 text-sm">
            <span className="text-content-muted">SKU</span>
            <Badge>{sku}</Badge>
            <span className="text-content-subtle">not editable</span>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Name">
              <Input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>

            <Field
              label="Category"
              hint={
                <Link href="/categories" className="font-medium text-accent hover:underline">
                  Manage categories
                </Link>
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
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save changes'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => router.push('/products')}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
