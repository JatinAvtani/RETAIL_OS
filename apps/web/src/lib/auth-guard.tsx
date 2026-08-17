'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { AppShell, type ContentWidth } from '@/components/app-shell';
import { LogoMark } from '@/components/logo';

/**
 * The only way this app knows "am I logged in" — the session cookie is httpOnly, so it can't be
 * read directly. `auth.me` throwing (a 401 from `protectedProcedure`) is the "not logged in"
 * signal; anything else is treated as a real failure and still bounces to /login rather than
 * silently rendering a broken authenticated page. Shared by every authenticated section
 * (/products, /recipes, ...) rather than duplicated per section.
 *
 * Also wraps children in `AppShell`, so nav/theme/sign-out come with authentication rather than
 * every section's layout having to remember to add them.
 *
 * `width` selects the content column for the section — see `ContentWidth` in `app-shell` for why a
 * dashboard, a dense table and a form each want a different one.
 */
export const AuthGuard = ({ children, width }: { children: ReactNode; width?: ContentWidth }) => {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    trpc.auth.me
      .query()
      .then(() => setChecked(true))
      .catch(() => router.replace('/login'));
  }, [router]);

  if (!checked) {
    // The app's very first paint. A bare spinner here reads as "something is broken or slow";
    // the mark reads as "this is Vyapaar, starting up" — and it is the one moment every user
    // passes through on every visit, so it is worth branding properly.
    return (
      <div className="grid min-h-screen place-items-center px-6">
        <div className="flex flex-col items-center gap-4">
          <LogoMark className="size-9 animate-pulse text-content motion-reduce:animate-none" />
          <p className="text-sm text-content-subtle">Checking your session…</p>
        </div>
      </div>
    );
  }

  return <AppShell {...(width ? { width } : {})}>{children}</AppShell>;
};
