import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@retailos/api';

/**
 * Exported because OAuth is not a tRPC call: `/auth/google` is a plain browser redirect on the API
 * origin, so the sign-in and sign-up screens need the same base URL this client uses. Duplicating
 * the `?? 'http://localhost:3001'` fallback in a component would silently diverge the day the real
 * deployment sets NEXT_PUBLIC_API_URL.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Direct browser -> API calls (not a Next.js proxy) — apps/api has CORS configured for exactly
 * this origin. `credentials: 'include'` is required for the __Host-session cookie to be sent
 * cross-origin; the API's CORS config must echo this origin (not '*') for that to work per the
 * fetch spec.
 */
export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${API_URL}/trpc`,
      fetch(url, options) {
        // tRPC's fetch options type allows `signal: AbortSignal | undefined`; DOM's RequestInit
        // wants `AbortSignal | null` under exactOptionalPropertyTypes — coerced explicitly rather
        // than spreading `options` wholesale, since a bare spread hits the same mismatch.
        return fetch(url, {
          ...options,
          signal: options?.signal ?? null,
          credentials: 'include',
        });
      },
    }),
  ],
});
