import type { ReactNode } from 'react';
import { AuthGuard } from '@/lib/auth-guard';

export default function NotificationsLayout({ children }: { children: ReactNode }) {
  return <AuthGuard width="dashboard">{children}</AuthGuard>;
}
