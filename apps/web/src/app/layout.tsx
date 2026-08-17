import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vyapaar',
  description: 'Know where your margin goes.',
  icons: { icon: '/icon.svg' },
};

/*
 * Applies the stored theme before first paint. Without this the page renders light, then flips to
 * dark once React hydrates — a visible flash on every load for anyone using the dark theme. It has
 * to be a blocking inline script in <head> for that reason; a useEffect runs too late.
 */
const themeInitScript = `
(function () {
  try {
    var stored = localStorage.getItem('retailos-theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (stored === 'dark' || (stored === null && prefersDark)) {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/*
         * Two faces, two jobs. Public Sans carries the interface: it was commissioned for public
         * -service forms and records, so it was drawn for exactly this product's condition of use —
         * text people must read correctly, small, when tired. JetBrains Mono carries every figure;
         * see `--font-mono` in globals.css for why numbers get a face of their own rather than just
         * `tabular-nums` on the body face.
         */}
        <link
          href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
