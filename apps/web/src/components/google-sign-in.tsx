import { API_URL } from '@/lib/trpc';

/**
 * Google's four-colour "G". Reproduced exactly — Google's brand guidelines require the mark be used
 * unmodified and in colour, so this is the one place in the interface where a colour outside the
 * token palette is correct. The button *chrome* around it still follows the design system (same
 * border, radius, height and type as `Button variant="secondary"`), which is the split the
 * guidelines actually ask for: their mark, our surface.
 */
const GoogleMark = () => (
  <svg viewBox="0 0 18 18" aria-hidden="true" className="size-4 shrink-0">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
    <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
  </svg>
);

/**
 * Entry point to the Google sign-in flow.
 *
 * The whole OAuth backend — authorization redirect, callback, Redis-backed CSRF state, account
 * linking, rate limiting — has been built and working for some time, but nothing in the UI ever
 * linked to it, so the feature was unreachable for every user. This is the link.
 *
 * A real `<a>`, not a button with an onClick: `/auth/google` answers with a 302 to Google's consent
 * screen, so this must be a genuine navigation. It also points at the API origin, not the web
 * origin — the route lives on Fastify (see apps/api/src/oauth/routes.ts, registered in server.ts),
 * which is why it cannot be a tRPC call and is not same-origin.
 */
export const GoogleSignIn = ({ label = 'Continue with Google' }: { label?: string }) => (
  <a
    href={`${API_URL}/auth/google`}
    className="inline-flex w-full items-center justify-center gap-2.5 rounded-control border border-border-strong bg-surface-raised px-4 py-1.5 text-sm font-semibold text-content transition-colors hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
  >
    <GoogleMark />
    {label}
  </a>
);
