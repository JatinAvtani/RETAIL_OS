import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'Name your workspace' };

export default function CompleteSignupLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
