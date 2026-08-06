import type { ReactNode } from 'react';
import { AuthGuard } from '@/lib/auth-guard';

export default function PosItemsLayout({ children }: { children: ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>;
}
