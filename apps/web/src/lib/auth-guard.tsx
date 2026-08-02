'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc';

/**
 * The only way this app knows "am I logged in" — the session cookie is httpOnly, so it can't be
 * read directly. `auth.me` throwing (a 401 from `protectedProcedure`) is the "not logged in"
 * signal; anything else is treated as a real failure and still bounces to /login rather than
 * silently rendering a broken authenticated page. Shared by every authenticated section
 * (/products, /recipes, ...) rather than duplicated per section.
 */
export const AuthGuard = ({ children }: { children: ReactNode }) => {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    trpc.auth.me
      .query()
      .then(() => setChecked(true))
      .catch(() => router.replace('/login'));
  }, [router]);

  if (!checked) {
    return <p>Loading...</p>;
  }

  return <>{children}</>;
};
