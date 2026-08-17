'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { Button, Card, ErrorNotice, Field, Input } from '@/components/ui';
import { ThemeToggle } from '@/components/theme-toggle';

/**
 * Closes the single highest-priority gap found by the UI audit: `auth.signup` existed with zero UI
 * entry point, and — a real, previously-undiscovered backend gap fixed alongside this page — signup
 * itself only ever created a `users` row with no organization to belong to (only `seed-demo.mts`, a
 * raw offline script, ever created one). `createOrganizationWithOwner` (`@retailos/db`) now runs
 * inside `auth.signup` itself, so this form collects the workspace's name/store alongside the
 * account's own email/password — confirmed with the user via `AskUserQuestion` as the real,
 * complete version of "sign up" rather than leaving the very first user with no path in.
 *
 * Redirects to `/verify-email` on success — the account cannot log in until that step succeeds
 * (`auth.login`'s own existing `emailVerifiedAt` check), matching the product's real posture.
 */
export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [storeName, setStoreName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const storeTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const result = await trpc.auth.signup.mutate({ email, password, organizationName, storeName, storeTimezone });
      // No email-sending infrastructure exists yet (a real, documented project limitation) — the
      // verification token is returned directly to the caller instead. Passed via a query param so
      // /verify-email can auto-submit it, the honest stand-in for "click the link in your email."
      const devToken = result._devOnlyVerificationToken;
      router.push(devToken ? `/verify-email?token=${encodeURIComponent(devToken)}` : '/verify-email');
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Something went wrong. Try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <div className="absolute right-6 top-6">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="mx-auto mb-3 grid size-10 place-items-center rounded-xl bg-accent text-accent-content">
            R
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-content">Create your workspace</h1>
          <p className="mt-1 text-sm text-content-muted">
            Operations intelligence for cafés, bakeries, and restaurants.
          </p>
        </div>

        <Card className="p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <ErrorNotice>{error}</ErrorNotice>}

            <Field label="Business name">
              <Input
                value={organizationName}
                onChange={(event) => setOrganizationName(event.target.value)}
                required
                placeholder="Ardent Bakehouse"
              />
            </Field>

            <Field label="First store name">
              <Input
                value={storeName}
                onChange={(event) => setStoreName(event.target.value)}
                required
                placeholder="Mill Street"
              />
            </Field>

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
                autoComplete="new-password"
                placeholder="••••••••"
              />
            </Field>

            <Button type="submit" variant="primary" disabled={submitting} className="w-full">
              {submitting ? 'Creating your workspace…' : 'Create workspace'}
            </Button>
          </form>
        </Card>

        <p className="mt-4 text-center text-sm text-content-muted">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
