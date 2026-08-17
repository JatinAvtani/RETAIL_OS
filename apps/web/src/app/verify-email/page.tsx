'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { Button, Card, ErrorNotice } from '@/components/ui';
import { ThemeToggle } from '@/components/theme-toggle';

type Status = 'idle' | 'verifying' | 'done' | 'error' | 'no-token';

const VerifyEmailContent = () => {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [status, setStatus] = useState<Status>(token ? 'verifying' : 'no-token');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    trpc.auth.verifyEmail
      .mutate({ token })
      .then(() => setStatus('done'))
      .catch((err) => {
        setError(err instanceof TRPCClientError ? err.message : 'Something went wrong. Try again.');
        setStatus('error');
      });
  }, [token]);

  return (
    <Card className="p-6 text-center">
      {status === 'no-token' && (
        <>
          <h1 className="text-lg font-semibold text-content">Check your email</h1>
          <p className="mt-2 text-sm text-content-muted">
            We&rsquo;ve sent a verification link to the address you signed up with. Click it to activate your
            account.
          </p>
        </>
      )}
      {status === 'verifying' && <p className="text-sm text-content-muted">Verifying your email…</p>}
      {status === 'done' && (
        <>
          <h1 className="text-lg font-semibold text-content">Email verified</h1>
          <p className="mt-2 text-sm text-content-muted">Your account is ready. You can sign in now.</p>
          <Link href="/login">
            <Button variant="primary" className="mt-4 w-full">
              Sign in
            </Button>
          </Link>
        </>
      )}
      {status === 'error' && (
        <>
          <ErrorNotice>{error}</ErrorNotice>
          <p className="mt-3 text-sm text-content-muted">
            <Link href="/signup" className="font-medium text-accent hover:underline">
              Sign up again
            </Link>{' '}
            to get a fresh verification link.
          </p>
        </>
      )}
    </Card>
  );
};

/**
 * The other half of the signup→verify→login chain — previously had no page at all, so even if
 * `/signup` had existed, a returned verification token had nowhere to be consumed. `useSearchParams`
 * requires a Suspense boundary in the App Router (a real Next.js constraint, not stylistic).
 */
export default function VerifyEmailPage() {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <div className="absolute right-6 top-6">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <Suspense fallback={<Card className="p-6 text-center text-sm text-content-muted">Loading…</Card>}>
          <VerifyEmailContent />
        </Suspense>
      </div>
    </main>
  );
}
