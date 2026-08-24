import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'Invitation' };

export default function InvitationsLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
