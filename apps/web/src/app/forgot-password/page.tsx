'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { Button, Card, ErrorNotice, Field, Input } from '@/components/ui';
import { ThemeToggle } from '@/components/theme-toggle';

/**
 * `auth.requestPasswordReset` had zero UI entry point — a locked-out user had no self-service
 * recovery path at all. Enumeration-safe by design (the backend returns the identical message
 * whether or not the email exists), so this page never reveals whether an account was found either.
 */
export default function ForgotPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const result = await trpc.auth.requestPasswordReset.mutate({ email });
      // No email-sending infrastructure exists yet — same real, documented posture as signup's
      // verification token. The dev-only token routes straight to /reset-password so the flow is
      // exercisable end-to-end; a real deployment removes this the moment email delivery exists.
      const devToken = result._devOnlyPasswordResetToken;
      router.push(devToken ? `/reset-password?token=${encodeURIComponent(devToken)}` : '/login');
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
          <h1 className="text-xl font-semibold tracking-tight text-content">Reset your password</h1>
          <p className="mt-1 text-sm text-content-muted">
            Enter your email and we&rsquo;ll send a link to reset your password.
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

            <Button type="submit" variant="primary" disabled={submitting} className="w-full">
              {submitting ? 'Sending…' : 'Send reset link'}
            </Button>
          </form>
        </Card>

        <p className="mt-4 text-center text-sm text-content-muted">
          <Link href="/login" className="font-medium text-accent hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
