'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { Button, Card, ErrorNotice, Field, Input } from '@/components/ui';
import { LogoMark } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';

const ResetPasswordContent = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token) return;
    setError(null);
    setSubmitting(true);

    try {
      await trpc.auth.resetPassword.mutate({ token, newPassword });
      router.push('/login');
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Something went wrong. Try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <Card className="p-6 text-center">
        <ErrorNotice>This password reset link is missing its token.</ErrorNotice>
        <p className="mt-3 text-sm text-content-muted">
          <Link href="/forgot-password" className="font-medium text-accent hover:underline">
            Request a new one
          </Link>
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <ErrorNotice>{error}</ErrorNotice>}

        <Field label="New password">
          <Input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            required
            autoComplete="new-password"
            placeholder="••••••••"
          />
        </Field>

        <Button type="submit" variant="primary" disabled={submitting} className="w-full">
          {submitting ? 'Resetting…' : 'Reset password'}
        </Button>
      </form>
    </Card>
  );
};

/** Consumes `auth.resetPassword`'s token — the other half of a flow that previously had no page at all. `resetPassword` revokes every existing session on success (a real backend guarantee, not just a UI nicety), so this redirects to /login rather than assuming any prior session survived. */
export default function ResetPasswordPage() {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <div className="absolute right-6 top-6">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <LogoMark className="mx-auto mb-5 size-11 text-content" />
          <h1 className="text-xl font-semibold tracking-tight text-content">Choose a new password</h1>
        </div>
        <Suspense fallback={<Card className="p-6 text-center text-sm text-content-muted">Loading…</Card>}>
          <ResetPasswordContent />
        </Suspense>
      </div>
    </main>
  );
}
