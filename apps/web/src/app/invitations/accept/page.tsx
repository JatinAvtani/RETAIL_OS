'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { Button, Card, ErrorNotice } from '@/components/ui';
import { LogoMark } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';

type Status = 'checking-session' | 'needs-login' | 'accepting' | 'done' | 'error' | 'no-token';

/**
 * `invitations.accept` had zero UI entry point. It's a `protectedProcedure` — the invitee must
 * already be signed in with an account whose email matches the invitation before it will succeed
 * (this is what prevents "accepting while logged in as someone else silently switches accounts",
 * confirmed in the router's own comment) — so this page first checks for a real session via
 * `auth.me`; if none exists, it sends the invitee to `/login` with the token preserved in the
 * return URL rather than failing outright. A brand-new invitee with no account yet still needs
 * `/signup` first — the login page's own "Sign up" link covers that; this page doesn't duplicate a
 * second signup form.
 */
const AcceptInvitationContent = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [status, setStatus] = useState<Status>(token ? 'checking-session' : 'no-token');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    // Two independent failure points, checked in sequence: `auth.me` failing at all means "not
    // logged in" (the same signal `auth-guard.tsx` already treats this way — a 401 from
    // `protectedProcedure` is the only way this call ever fails), never accepted. `accept` failing
    // AFTER a real session was confirmed is a genuine invitation error (expired/already used/wrong
    // account), never conflated with "not logged in."
    trpc.auth.me
      .query()
      .catch(() => {
        setStatus('needs-login');
        throw new Error('not-logged-in');
      })
      .then(() => {
        setStatus('accepting');
        return trpc.invitations.accept.mutate({ token });
      })
      .then(() => setStatus('done'))
      .catch((err) => {
        if (err instanceof Error && err.message === 'not-logged-in') return;
        setError(err instanceof TRPCClientError ? err.message : 'Something went wrong. Try again.');
        setStatus('error');
      });
  }, [token]);

  const returnUrl = token ? `/invitations/accept?token=${encodeURIComponent(token)}` : '/invitations/accept';

  return (
    <>
      <LogoMark className="mx-auto mb-5 size-11 text-content" />
      <Card className="p-6 text-center">
      {status === 'no-token' && <ErrorNotice>This invitation link is missing its token.</ErrorNotice>}
      {status === 'checking-session' && <p className="text-sm text-content-muted">Checking your session…</p>}
      {status === 'accepting' && <p className="text-sm text-content-muted">Joining the team…</p>}
      {status === 'needs-login' && (
        <>
          <h1 className="text-lg font-semibold text-content">Sign in to accept this invitation</h1>
          <p className="mt-2 text-sm text-content-muted">
            You&rsquo;ll need to sign in (or create an account) with the email this invitation was sent to.
          </p>
          <Link href={`/login?returnTo=${encodeURIComponent(returnUrl)}`}>
            <Button variant="primary" className="mt-4 w-full">
              Sign in
            </Button>
          </Link>
        </>
      )}
      {status === 'done' && (
        <>
          <h1 className="text-lg font-semibold text-content">You&rsquo;re in</h1>
          <p className="mt-2 text-sm text-content-muted">You&rsquo;ve joined the team.</p>
          <Button variant="primary" className="mt-4 w-full" onClick={() => router.push('/dashboard')}>
            Go to dashboard
          </Button>
        </>
      )}
      {status === 'error' && <ErrorNotice>{error}</ErrorNotice>}
    </Card>
    </>
  );
};

export default function AcceptInvitationPage() {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <div className="absolute right-6 top-6">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <Suspense fallback={<Card className="p-6 text-center text-sm text-content-muted">Loading…</Card>}>
          <AcceptInvitationContent />
        </Suspense>
      </div>
    </main>
  );
}
