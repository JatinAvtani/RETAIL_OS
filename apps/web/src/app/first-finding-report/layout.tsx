import type { ReactNode } from 'react';
import { AuthGuard } from '@/lib/auth-guard';

export default function FirstFindingReportLayout({ children }: { children: ReactNode }) {
  return <AuthGuard width="dashboard">{children}</AuthGuard>;
}
