import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthGuard } from '@/lib/auth-guard';

export const metadata: Metadata = { title: 'Integrations' };

export default function IntegrationsLayout({ children }: { children: ReactNode }) {
  return <AuthGuard width="form">{children}</AuthGuard>;
}
