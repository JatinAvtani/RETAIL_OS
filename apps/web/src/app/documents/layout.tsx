import type { ReactNode } from 'react';
import { AuthGuard } from '@/lib/auth-guard';

export default function DocumentsLayout({ children }: { children: ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>;
}
