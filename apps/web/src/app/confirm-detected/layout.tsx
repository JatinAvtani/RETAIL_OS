import type { ReactNode } from 'react';
import { AuthGuard } from '@/lib/auth-guard';

export default function ConfirmDetectedLayout({ children }: { children: ReactNode }) {
  return <AuthGuard width="table">{children}</AuthGuard>;
}
