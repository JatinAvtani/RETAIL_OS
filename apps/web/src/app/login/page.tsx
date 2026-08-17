'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { Button, Card, ErrorNotice, Field, Input } from '@/components/ui';
import { ThemeToggle } from '@/components/theme-toggle';

const LoginForm = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  // `/invitations/accept` sends an invitee here with `returnTo` set so a fresh login lands back on
  // the invitation instead of the dashboard — the only real caller of this param today.
  const returnTo = searchParams.get('returnTo');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await trpc.auth.login.mutate({ email, password });
      router.push(returnTo && returnTo.startsWith('/') ? returnTo : '/dashboard');
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Something went wrong. Try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 text-center">
        <span className="mx-auto mb-3 grid size-10 place-items-center rounded-xl bg-accent text-accent-content">
          R
        </span>
        <h1 className="text-xl font-semibold tracking-tight text-content">Sign in to RetailOS</h1>
        <p className="mt-1 text-sm text-content-muted">
          Operations intelligence for cafés, bakeries, and restaurants.
        </p>
      </div>

      <Card className="p-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <ErrorNotice>{error}</ErrorNotice>}

          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
              placeholder="you@yourcafe.com"
            />
          </Field>

          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete="current-password"
              placeholder="••••••••"
            />
          </Field>

          <div className="flex justify-end">
            <Link href="/forgot-password" className="text-xs font-medium text-accent hover:underline">
              Forgot password?
            </Link>
          </div>

          <Button type="submit" variant="primary" disabled={submitting} className="w-full">
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>

      <p className="mt-4 text-center text-sm text-content-muted">
        New to RetailOS?{' '}
        <Link href="/signup" className="font-medium text-accent hover:underline">
          Create a workspace
        </Link>
      </p>
    </div>
  );
};

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <div className="absolute right-6 top-6">
        <ThemeToggle />
      </div>
      <Suspense fallback={<div className="text-sm text-content-muted">Loading…</div>}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
