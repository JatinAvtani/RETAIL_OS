import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthGuard } from '@/lib/auth-guard';

export const metadata: Metadata = { title: 'Import templates' };

export default function ImportTemplatesLayout({ children }: { children: ReactNode }) {
  return <AuthGuard width="table">{children}</AuthGuard>;
}
