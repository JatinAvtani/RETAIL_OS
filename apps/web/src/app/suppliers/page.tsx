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
  PageHeader,
  SkeletonRows,
  StatTile,
  StatTileGrid,
  Table,
  Td,
  Th,
  Tr,
  Value,
} from '@/components/ui';

type Supplier = Awaited<ReturnType<typeof trpc.suppliers.list.query>>[number];

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    trpc.suppliers.list
      .query()
      .then(setSuppliers)
      .catch(() => setError('Could not load suppliers.'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <PageHeader
        title="Suppliers"
        description="Who you buy from."
        actions={
          <Link href="/suppliers/new">
            <Button variant="primary">New supplier</Button>
          </Link>
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      {!loading && !error && suppliers.length > 0 && (
        <StatTileGrid className="mb-6">
          <StatTile
            label="Total suppliers"
            value={String(suppliers.length)}
            unknownReason="No suppliers recorded yet"
          />
          <StatTile
            label="Active"
            value={String(suppliers.filter((s) => s.status === 'active').length)}
            unknownReason="No suppliers recorded yet"
          />
          <StatTile
            label="Inactive"
            value={String(suppliers.filter((s) => s.status !== 'active').length)}
            unknownReason="No suppliers recorded yet"
          />
          <StatTile
            label="Missing contracted lead time"
            value={String(suppliers.filter((s) => s.leadTimeDaysContracted === null).length)}
            hint="Needed for accurate reorder timing"
            unknownReason="No suppliers recorded yet"
          />
        </StatTileGrid>
      )}

      <Card>
        {loading && <SkeletonRows columns={5} />}
        {!loading && !error && suppliers.length === 0 && (
          <EmptyState title="No suppliers yet" hint="Add your first supplier to start creating purchase orders." />
        )}
        {!loading && !error && suppliers.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Payment terms</Th>
                <Th>Lead time (contracted)</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {suppliers.map((supplier) => (
                <Tr key={supplier.id}>
                  <Td className="font-medium">{supplier.name}</Td>
                  <Td className="text-content-muted">
                    <Value value={supplier.paymentTerms} />
                  </Td>
                  <Td className="text-content-muted">
                    <Value
                      value={supplier.leadTimeDaysContracted !== null ? supplier.leadTimeDaysContracted : null}
                      unit="d"
                    />
                  </Td>
                  <Td>
                    <Badge tone={supplier.status === 'active' ? 'positive' : 'neutral'}>
                      {humanizeEnum(supplier.status)}
                    </Badge>
                  </Td>
                  <Td variant="actions">
                    <Link href={`/suppliers/${supplier.id}/edit`} className="text-sm font-medium text-accent hover:underline">
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
