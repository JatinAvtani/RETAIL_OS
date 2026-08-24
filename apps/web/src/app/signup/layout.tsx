import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'Create an account' };

export default function SignupLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
