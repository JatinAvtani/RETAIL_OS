import type { ReactNode } from 'react';
import { AuthGuard } from '@/lib/auth-guard';

export default function CategoriesLayout({ children }: { children: ReactNode }) {
  return <AuthGuard width="form">{children}</AuthGuard>;
}
