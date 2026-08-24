'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { Button, Card, ErrorNotice, Field, Input, Select } from '@/components/ui';
import { LogoLockup } from '@/components/logo';
import { AuthPage } from '@/components/auth-page';
import { PasswordInput } from '@/components/password-input';
import { GoogleSignIn } from '@/components/google-sign-in';

const CURRENCIES = [
  { code: 'INR', label: 'INR — Indian Rupee (₹)' },
  { code: 'USD', label: 'USD — US Dollar ($)' },
  { code: 'EUR', label: 'EUR — Euro (€)' },
  { code: 'GBP', label: 'GBP — British Pound (£)' },
] as const;

/**
 * Closes the single highest-priority gap found by the UI audit: `auth.signup` existed with zero UI
 * entry point, and — a real, previously-undiscovered backend gap fixed alongside this page — signup
 * itself only ever created a `users` row with no organization to belong to (only `seed-demo.mts`, a
 * raw offline script, ever created one). `createOrganizationWithOwner` (`@retailos/db`) now runs
 * inside `auth.signup` itself, so this form collects the workspace's name/store/currency alongside
 * the account's own email/password — settled deliberately: as the real,
 * complete version of "sign up" rather than leaving the very first user with no path in.
 *
 * The currency choice is real and one-time — no conversion/exchange-rate logic exists anywhere in
 * this codebase (confirmed before this field was added), so it's only safe to offer once, before
 * any real financial data exists; there is deliberately no way to change it after signup.
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
  const [baseCurrency, setBaseCurrency] = useState<(typeof CURRENCIES)[number]['code']>('INR');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const storeTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const result = await trpc.auth.signup.mutate({ email, password, organizationName, storeName, storeTimezone, baseCurrency });
      // No email-sending infrastructure exists yet (a real, documented project limitation) — the
      // verification token is returned directly to the caller instead. Passed via a query param so
      // /verify-email can auto-submit it, the honest stand-in for "click the link in your email."
      // Optional by design: the API omits it entirely in production (see `devOnlyToken`), so this
      // reads it defensively rather than asserting a field that legitimately will not be there.
      const devToken = (result as { _devOnlyVerificationToken?: string })._devOnlyVerificationToken;
      router.push(devToken ? `/verify-email?token=${encodeURIComponent(devToken)}` : '/verify-email');
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Something went wrong. Try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthPage intro>
      <div className="w-full max-w-sm lg:w-[31rem] lg:max-w-none">
        {/* Same reasoning as the sign-in screen: the lockup says the name and what it means, so the
            heading states only the task. */}
        {/* "Create your account", not "Create your workspace". The old wording named the OUTCOME
            (a workspace exists afterwards) rather than the ACTION, so someone scanning the page did
            not necessarily register that they were signing up at all — the word "account" is what
            makes that unambiguous. The subheading then explains what else the form does, since this
            single step creates an account AND the business and store it belongs to. */}
        <LogoLockup className="mb-8 flex w-full items-center lg:hidden" />

        <Card className="p-8">
          <h1 className="text-center text-lg font-semibold tracking-tight text-content">Create your account</h1>
          <p className="mb-5 mt-1.5 text-center text-sm text-content-muted">
            Sets up your Vyapaar account and your first store.
          </p>


          {/* Google IS offered here now. It was deliberately withheld while a Google sign-in with
              no workspace dead-ended: the account was created, `establishSessionForUser` failed
              `no_membership`, and the orphaned row then owned the email address so this form could
              not be used either. `completeGoogleSignup` closed that hole — a Google visitor with no
              workspace is handed a provisioning session and sent to /complete-signup to supply the
              business name, store name and currency Google cannot provide. Both routes now end in a
              real workspace, so the familiar button is no longer a trap. */}
          <div className="mb-6">
            <GoogleSignIn label="Sign up with Google" />
          </div>

          <div className="mb-6 flex items-center gap-3 text-xs text-content-subtle">
            <div className="h-px flex-1 bg-border" />
            or
            <div className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
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
                autoComplete="new-password"
                placeholder="••••••••"
              />
            </Field>

            <Button type="submit" variant="primary" disabled={submitting} className="w-full">
              {submitting ? 'Creating your account…' : 'Create account'}
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-sm text-content-muted">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </AuthPage>
  );
}
