import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthGuard } from '@/lib/auth-guard';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <AuthGuard width="form">{children}</AuthGuard>;
}
