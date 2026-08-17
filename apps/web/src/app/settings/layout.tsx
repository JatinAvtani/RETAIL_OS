import type { ReactNode } from 'react';
import { AuthGuard } from '@/lib/auth-guard';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <AuthGuard width="form">{children}</AuthGuard>;
}
