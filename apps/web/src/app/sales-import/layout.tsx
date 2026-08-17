import type { ReactNode } from 'react';
import { AuthGuard } from '@/lib/auth-guard';

export default function SalesImportLayout({ children }: { children: ReactNode }) {
  return <AuthGuard width="table">{children}</AuthGuard>;
}
