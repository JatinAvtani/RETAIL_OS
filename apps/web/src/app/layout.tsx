import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  /*
   * `default` titles the pages that set nothing; `template` names the rest. Before this, every
   * route in the app rendered the bare string 'Vyapaar', so a user with the dashboard, inventory
   * and a purchase order open saw three identical tabs and had to click through to tell them
   * apart — the tab strip is a navigation surface, and it was carrying no information at all.
   *
   * Page name first, product second: a tab is truncated from the right, so the distinguishing word
   * has to lead or it is the first thing lost. The en dash rather than a pipe matches the
   * typographic register of the rest of the interface.
   */
  title: {
    default: 'Vyapaar — know where your margin goes',
    template: '%s — Vyapaar',
  },
  description: 'Know where your margin goes.',
  icons: {
    // Both forms on purpose: the SVG is the primary declared icon, but plenty of consumers
    // (Safari, link unfurlers, older chrome) request /favicon.ico unconditionally and use only
    // that — with a 404 there they show a blank tab icon regardless of this declaration.
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: '32x32' },
    ],
  },
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
         * Three faces, three jobs. Public Sans carries the interface: it was commissioned for public
         * -service forms and records, so it was drawn for exactly this product's condition of use —
         * text people must read correctly, small, when tired. JetBrains Mono carries every figure;
         * see `--font-mono` in globals.css for why numbers get a face of their own rather than just
         * `tabular-nums` on the body face.
         *
         * Fraunces is loaded for ONE string — the wordmark in `logo.tsx` — and only at the single
         * weight it uses (600), so the third face costs one small subset rather than a full variable
         * family. It is deliberately not exposed as a general-purpose face; see `--font-display`.
         */}
        <link
          href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Fraunces:opsz,wght@9..144,600&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
