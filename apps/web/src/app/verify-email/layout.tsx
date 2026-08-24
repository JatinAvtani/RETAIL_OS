import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'Verify your email' };

export default function VerifyEmailLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
