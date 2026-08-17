'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { Button, Card, ErrorNotice, Field, Input, PageHeader, SkeletonRows, Select, Table, Td, Th, Tr } from '@/components/ui';

type Category = Awaited<ReturnType<typeof trpc.categories.list.query>>[number];

/**
 * The dead end the UI audit found: `categories.create` existed server-side with zero UI anywhere,
 * so a fresh org with no seeded categories had no way to create the FIRST one — `/products/new`'s
 * category dropdown was permanently empty for a brand-new tenant. This page is the real fix, not a
 * cosmetic one: a flat name+parent create form plus an indented tree view (indentation derived from
 * `path`'s segment count, the same source of truth CategoryRepository itself maintains).
 */
export default function CategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [creating, setCreating] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    trpc.categories.list
      .query()
      .then(setCategories)
      .catch(() => setError('Could not load categories.'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setCreating(true);
    try {
      await trpc.categories.create.mutate({ name, ...(parentId && { parentId }) });
      setName('');
      setParentId('');
      load();
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Something went wrong. Try again.';
      setError(message);
    } finally {
      setCreating(false);
    }
  };

  // Depth from path's segment count ('/id' = root, '/parent/id' = one level deep, ...) — the same
  // value CategoryRepository itself derives, not a second independent computation of it.
  const sorted = [...categories].sort((a, b) => a.path.localeCompare(b.path));
  const depthOf = (category: Category) => category.path.split('/').filter(Boolean).length - 1;

  return (
    <>
      <PageHeader title="Categories" description="Group your products for filtering and reports." />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <Card className="mb-6 max-w-xl p-6">
        <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
          <Field label="Name">
            <Input type="text" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Dairy" />
          </Field>
          <Field label="Parent" hint="Optional.">
            <Select value={parentId} onChange={(e) => setParentId(e.target.value)} className="w-48">
              <option value="">None (top-level)</option>
              {sorted.map((category) => (
                <option key={category.id} value={category.id}>
                  {'—'.repeat(depthOf(category))} {category.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="primary" disabled={creating || name.trim() === ''}>
            {creating ? 'Creating…' : 'Add category'}
          </Button>
        </form>
      </Card>

      <Card>
        {loading && <SkeletonRows columns={3} />}
        {!loading && !error && sorted.length === 0 && (
          <div className="p-6 text-sm text-content-subtle">No categories yet — add your first one above.</div>
        )}
        {!loading && !error && sorted.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((category) => (
                <Tr key={category.id}>
                  <Td>
                    <span style={{ paddingLeft: `${depthOf(category) * 1.5}rem` }} className="inline-block">
                      {category.name}
                    </span>
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
