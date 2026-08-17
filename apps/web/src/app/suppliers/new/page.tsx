'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { Button, Card, ErrorNotice, Field, Input, PageHeader } from '@/components/ui';

export default function NewSupplierPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const created = await trpc.suppliers.create.mutate({ name });
      router.push(`/suppliers/${created.id}/edit`);
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Something went wrong. Try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHeader title="New supplier" description="Add the contacts and terms on the next screen." />

      <Card className="max-w-2xl p-6">
        <form onSubmit={handleSubmit} className="space-y-5">
          {error && <ErrorNotice>{error}</ErrorNotice>}

          <Field label="Name">
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Metro Foods Distribution"
            />
          </Field>

          <div className="flex items-center gap-2 border-t border-border pt-5">
            <Button type="submit" variant="primary" disabled={submitting || name.trim() === ''}>
              {submitting ? 'Creating…' : 'Create supplier'}
            </Button>
            <Link href="/suppliers">
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
