'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Input,
  LoadingState,
  PageHeader,
  Table,
  Td,
  Th,
  Tr,
  type BadgeTone,
} from '@/components/ui';

type Product = Awaited<ReturnType<typeof trpc.products.list.query>>[number];

const TYPE_TONES: Record<string, BadgeTone> = {
  INGREDIENT: 'neutral',
  SELLABLE: 'accent',
  BOTH: 'positive',
};

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
    <>
      <PageHeader
        title="Products"
        description="Everything you buy or make — ingredients, prepared items, and the units they're tracked in."
        actions={
          <Link href="/products/new">
            <Button variant="primary">New product</Button>
          </Link>
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <div className="mb-4 max-w-xs">
        <Input
          type="search"
          placeholder="Search by name…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <Card>
        {loading && <LoadingState />}
        {!loading && !error && products.length === 0 && (
          <EmptyState
            title="No products yet"
            hint={search ? 'Try a different search term.' : 'Add your first product to get started.'}
          />
        )}
        {!loading && !error && products.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>SKU</Th>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <Tr key={product.id}>
                  <Td className="tabular text-content-muted">{product.sku}</Td>
                  <Td className="font-medium">{product.name}</Td>
                  <Td>
                    <Badge tone={TYPE_TONES[product.type] ?? 'neutral'}>
                      {product.type.toLowerCase()}
                    </Badge>
                  </Td>
                  <Td align="right">
                    <Link
                      href={`/products/${product.id}/edit`}
                      className="text-sm font-medium text-accent hover:underline"
                    >
                      Edit
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
