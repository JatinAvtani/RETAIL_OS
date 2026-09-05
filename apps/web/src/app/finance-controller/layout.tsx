import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthGuard } from '@/lib/auth-guard';

export const metadata: Metadata = { title: 'Finance Controller' };

export default function FinanceControllerLayout({ children }: { children: ReactNode }) {
  // Own top-level route with its own layout — a standalone control-system page, not a mode of
  // /assistant (this epic's own design decision, see task.md). Nesting under an existing section
  // would double the AppShell, this project's own documented, repeat-hit layout-nesting trap.
  return <AuthGuard width="dashboard">{children}</AuthGuard>;
}
