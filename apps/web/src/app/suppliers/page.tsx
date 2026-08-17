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
  LoadingState,
  PageHeader,
  Table,
  Td,
  Th,
  Tr,
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
        description="Contacts, payment terms, delivery schedule, and lead times for who you buy from."
        actions={
          <Link href="/suppliers/new">
            <Button variant="primary">New supplier</Button>
          </Link>
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <Card>
        {loading && <LoadingState />}
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
                  <Td className="text-content-muted">{supplier.paymentTerms ?? '—'}</Td>
                  <Td className="text-content-muted">
                    {supplier.leadTimeDaysContracted !== null ? `${supplier.leadTimeDaysContracted}d` : '—'}
                  </Td>
                  <Td>
                    <Badge tone={supplier.status === 'active' ? 'positive' : 'neutral'}>{supplier.status}</Badge>
                  </Td>
                  <Td align="right">
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
