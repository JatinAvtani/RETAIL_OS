'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { humanizeEnum } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Input,
  PageHeader,
  SkeletonRows,
  StatTile,
  StatTileGrid,
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
        description="Everything you buy or make."
        actions={
          <Link href="/products/new">
            <Button variant="primary">New product</Button>
          </Link>
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      {!loading && !error && !search && products.length > 0 && (
        <StatTileGrid className="mb-6">
          <StatTile
            label="Total products"
            value={String(products.length)}
            unknownReason="No products recorded yet"
          />
          <StatTile
            label="Ingredients"
            value={String(products.filter((p) => p.type === 'INGREDIENT').length)}
            unknownReason="No products recorded yet"
          />
          <StatTile
            label="Sellable"
            value={String(products.filter((p) => p.type === 'SELLABLE').length)}
            unknownReason="No products recorded yet"
          />
          <StatTile
            label="Both"
            value={String(products.filter((p) => p.type === 'BOTH').length)}
            unknownReason="No products recorded yet"
          />
        </StatTileGrid>
      )}

      <div className="mb-4 max-w-xs">
        <Input
          type="search"
          placeholder="Search by name…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <Card>
        {loading && <SkeletonRows columns={5} />}
        {!loading && !error && products.length === 0 &&
          (search ? (
            <EmptyState
              variant="no-matches"
              title="No products match this search"
              hint="Nothing here matched that term — clearing it brings the full list back."
              action={
                <Button variant="secondary" onClick={() => setSearch('')}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No products yet"
              hint="Recipes, orders, and stock all depend on your products."
              action={
                <Link href="/products/new">
                  <Button variant="primary">Add a product</Button>
                </Link>
              }
            />
          ))}
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
                  <Td className="font-mono text-content-muted">{product.sku}</Td>
                  <Td className="font-medium">{product.name}</Td>
                  <Td>
                    <Badge tone={TYPE_TONES[product.type] ?? 'neutral'}>
                      {humanizeEnum(product.type)}
                    </Badge>
                  </Td>
                  <Td variant="actions">
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
