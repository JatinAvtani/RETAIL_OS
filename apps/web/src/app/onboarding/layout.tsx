import type { ReactNode } from 'react';
import { AuthGuard } from '@/lib/auth-guard';

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <AuthGuard width="form">{children}</AuthGuard>;
}
