import type { ReactNode } from 'react';
import { AuthGuard } from '@/lib/auth-guard';

export default function AssistantLayout({ children }: { children: ReactNode }) {
  // `dashboard`, not a narrow chat column — this page is a two-column layout (history rail + thread),
  // so it needs the same full working width every other multi-column screen uses.
  return <AuthGuard width="dashboard">{children}</AuthGuard>;
}
