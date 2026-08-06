'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { ThemeToggle } from './theme-toggle';
import { cx } from './ui';

const NAV = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/products', label: 'Products' },
  { href: '/recipes', label: 'Recipes' },
  { href: '/inventory', label: 'Inventory' },
  { href: '/documents', label: 'Documents' },
  { href: '/pos-items', label: 'POS mapping' },
];

export const AppShell = ({ children }: { children: ReactNode }) => {
  const pathname = usePathname();
  const router = useRouter();

  const logout = async () => {
    try {
      await trpc.auth.logout.mutate();
    } finally {
      // Bounce regardless — a failed logout call still shouldn't strand the user on an
      // authenticated-looking page.
      router.replace('/login');
    }
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-border bg-surface-raised/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-6">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold tracking-tight text-content">
            <span className="grid size-6 place-items-center rounded-md bg-accent text-xs text-accent-content">
              R
            </span>
            RetailOS
          </Link>

          <nav className="flex items-center gap-1">
            {NAV.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cx(
                    'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                    active
                      ? 'bg-accent-soft text-accent'
                      : 'text-content-muted hover:bg-surface-sunken hover:text-content'
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <button
              type="button"
              onClick={logout}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
};
