'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { Button, Card, ErrorNotice, Field, Input } from '@/components/ui';
import { LogoLockup } from '@/components/logo';
import { AuthPage } from '@/components/auth-page';
import { GoogleSignIn } from '@/components/google-sign-in';
import { PasswordInput } from '@/components/password-input';

/**
 * The OAuth callback has no way to render anything itself — it is a Fastify route that can only
 * redirect — so every failure comes back as `/login?error=<code>`. Before this map existed the
 * login page ignored the parameter entirely, so a declined consent, an expired state token or an
 * unlinked account all dumped the user back on a blank sign-in form with no explanation and no
 * idea what to do differently.
 *
 * Wording is deliberately about what the person should do next, not about what the protocol did.
 * `verify_password_account_first` is the subtle one: that address already has a password account,
 * and silently linking a Google identity to it on the strength of a matching email would be an
 * account-takeover vector — so the user is asked to sign in the way they originally registered.
 */
const OAUTH_ERRORS: Record<string, string> = {
  google_oauth_denied: 'Google sign-in was cancelled. Try again, or sign in with your password.',
  google_oauth_invalid_state: 'That sign-in link expired. Please try again.',
  google_oauth_failed: "Google sign-in didn't complete. Please try again.",
  verify_password_account_first:
    'This email already has a password account. Sign in with your password first, then link Google from settings.',
  no_membership: 'That account isn’t part of any workspace yet. Ask an owner to invite you.',
  multiple_organizations:
    'That account belongs to more than one workspace. Sign in with your password to choose one.',
};

const LoginForm = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  // `/invitations/accept` sends an invitee here with `returnTo` set so a fresh login lands back on
  // the invitation instead of the dashboard — the only real caller of this param today.
  const returnTo = searchParams.get('returnTo');
  // A failed OAuth round-trip lands here as a query param. Held separately from `error` (the form's
  // own submit failure) so that submitting the password form clears the stale OAuth banner rather
  // than showing two contradictory messages at once.
  const oauthError = OAUTH_ERRORS[searchParams.get('error') ?? ''];
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);

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

  /**
   * signs the visitor straight into the one real, shared demo tenant — a genuinely
   * isolated real tenant (I4), never a bypass, just a discoverable entry point into an account
   * that already exists (confirmed with the user: one shared tenant, not a fresh one per click).
   */
  const handleExploreDemo = async () => {
    setError(null);
    setDemoLoading(true);
    try {
      await trpc.auth.demoLogin.mutate();
      router.push('/dashboard');
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Could not start the demo. Try again.';
      setError(message);
    } finally {
      setDemoLoading(false);
    }
  };

  return (
    <div className="w-full max-w-sm lg:w-[31rem] lg:max-w-none">
      {/* The lockup carries the name and what it means, so the heading below no longer repeats
          either — it just states the task. Previously this read mark / "Sign in to Vyapaar" /
          "Know where your margin goes.", which said the product name twice and spent the largest
          type on the word "Sign". */}
      {/* Below `lg` only: at desktop width the brand pane carries the lockup, and two on one screen
          reads as a mistake rather than as emphasis. The heading stays at every width — the form
          needs its label regardless. */}
      <LogoLockup className="mb-8 flex w-full items-center lg:hidden" />

      <Card className="p-8">
        {/* Inside the card, not above it. Sitting outside, this heading had nothing to attach to
            once the layout became two columns — it read as a stray label floating between panes. */}
        <h1 className="mb-6 text-center text-lg font-semibold tracking-tight text-content">Sign in</h1>


        {/* The OAuth banner sits outside the form and above it: it describes something that already
            happened on a previous page load, not a validation failure of the fields below. It is
            suppressed once the user submits the form, since `error` then describes the newer
            attempt. */}
        {!error && oauthError && (
          <div className="mb-4">
            <ErrorNotice>{oauthError}</ErrorNotice>
          </div>
        )}

        <div className="space-y-3">
          <GoogleSignIn />
        </div>

        <div className="my-6 flex items-center gap-3 text-xs text-content-subtle">
          <div className="h-px flex-1 bg-border" />
          or
          <div className="h-px flex-1 bg-border" />
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
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
            <PasswordInput
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

        {/* A plain rule, not a second "or": the demo is a different kind of offer from the two real
            sign-in methods above it — it doesn't authenticate anyone, it opens a shared sample
            workspace — so stacking a second "or" would imply three equivalent choices. */}
        <div className="my-6 h-px bg-border" />

        <Button type="button" variant="secondary" disabled={demoLoading} onClick={handleExploreDemo} className="w-full">
          {demoLoading ? 'Loading demo…' : 'Explore with sample data'}
        </Button>
      </Card>

      <p className="mt-6 text-center text-sm text-content-muted">
        New to Vyapaar?{' '}
        <Link href="/signup" className="font-medium text-accent hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  );
};

export default function LoginPage() {
  return (
    <AuthPage intro>
      <Suspense fallback={<div className="text-sm text-content-muted">Loading…</div>}>
        <LoginForm />
      </Suspense>
    </AuthPage>
  );
}
