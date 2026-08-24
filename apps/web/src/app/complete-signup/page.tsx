'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { Button, Card, ErrorNotice, Field, Input, Select } from '@/components/ui';
import { LogoLockup } from '@/components/logo';
import { AuthPage } from '@/components/auth-page';

const CURRENCIES = [
  { code: 'INR', label: 'INR — Indian Rupee (₹)' },
  { code: 'USD', label: 'USD — US Dollar ($)' },
  { code: 'EUR', label: 'EUR — Euro (€)' },
  { code: 'GBP', label: 'GBP — British Pound (£)' },
] as const;

/**
 * The second half of a Google sign-up.
 *
 * Google establishes who someone is; it cannot say what their business is called, what their first
 * store is, or what currency they keep their books in. Before this page existed, a first-time
 * Google sign-in created a real user row, found no workspace for it, and bounced the person back to
 * /login with an error — leaving an account that owned their email address, could never sign in,
 * and blocked them from signing up properly with that same address. A permanent dead end, one click
 * deep. This page is what turns that into an ordinary first-run step.
 *
 * Only reachable with a provisioning session (see `provisioningProcedure`): a signed-out visitor
 * gets UNAUTHORIZED and a user who already has a workspace gets FORBIDDEN, so this cannot be used
 * to mint a second organization. There is no email or password field because the Google identity
 * already settled both — and pre-verified the address, so unlike password signup there is no
 * verification step after this.
 */
export default function CompleteSignupPage() {
  const router = useRouter();
  const [organizationName, setOrganizationName] = useState('');
  const [storeName, setStoreName] = useState('');
  const [baseCurrency, setBaseCurrency] = useState<(typeof CURRENCIES)[number]['code']>('INR');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const storeTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await trpc.auth.completeGoogleSignup.mutate({
        organizationName,
        storeName,
        storeTimezone,
        baseCurrency,
      });
      // The mutation swaps the provisioning cookie for a real session, so this lands on a genuinely
      // usable dashboard rather than bouncing off AuthGuard.
      router.push('/dashboard');
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Something went wrong. Try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await trpc.auth.logout.mutate();
    } finally {
      // Bounce regardless, matching AppShell's own logout: a failed revoke call must not strand
      // someone on a page they cannot otherwise leave.
      router.replace('/login');
    }
  };

  return (
    <AuthPage>
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <LogoLockup className="mb-7" />
          <h1 className="text-lg font-semibold tracking-tight text-content">Name your workspace</h1>
          <p className="mt-1.5 text-sm text-content-muted">
            You&rsquo;re signed in with Google. One more step — tell us about the business.
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
                autoFocus
                placeholder="Shanthi Coffee House"
              />
            </Field>

            <Field label="First store name">
              <Input
                value={storeName}
                onChange={(event) => setStoreName(event.target.value)}
                required
                placeholder="Koramangala"
              />
            </Field>

            <Field label="Currency" hint="Every number in your workspace uses this — it can't be changed later.">
              <Select
                value={baseCurrency}
                onChange={(event) => setBaseCurrency(event.target.value as (typeof CURRENCIES)[number]['code'])}
                required
              >
                {CURRENCIES.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Button type="submit" variant="primary" disabled={submitting} className="w-full">
              {submitting ? 'Creating your workspace…' : 'Create workspace'}
            </Button>
          </form>
        </Card>

        {/* The way out. This page is reached with a provisioning session, which `protectedProcedure`
            bars from every other route in the app — so without this link, someone who changed their
            mind had no exit at all: no sign-out button (that lives in AppShell, which this page
            deliberately does not use), every destination bouncing them back, and the cookie
            surviving a tab close. Signing out is the honest escape: the account itself is kept, and
            signing in with Google again returns them here. */}
        <p className="mt-4 text-center text-sm text-content-muted">
          Not right now?{' '}
          <button
            type="button"
            onClick={handleSignOut}
            className="font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Sign out
          </button>
        </p>
      </div>
    </AuthPage>
  );
}
