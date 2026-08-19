/** @type {import('next').NextConfig} */
const nextConfig = {
  // packages/domain and packages/ui are consumed as raw TS source (main/types point at src/index.ts,
  // no build step ships to a dist/ Next.js would resolve otherwise) — Next.js needs to be told to
  // transpile them itself rather than treating them as pre-built node_modules packages.
  transpilePackages: ['@retailos/domain', '@retailos/ui'],
  // The floating dev-route indicator sits exactly over the sidebar's Collapse control at this
  // layout's breakpoints, which reads as broken UI in any dev-server demo or screenshot. It
  // carries no information the terminal doesn't already show; production builds never render it.
  devIndicators: false,
  typescript: {
    // `pnpm typecheck` (this repo's real gate, one tsc --noEmit per package) already covers
    // apps/web. next build's own bundled typecheck pass is redundant with that AND more
    // aggressive: importing AppRouter's TYPE from @retailos/api (for end-to-end tRPC inference)
    // pulls Next's typecheck into apps/api's full implementation, not just its public surface,
    // where it hits a @fastify/cookie type-augmentation quirk apps/api's own isolated
    // `tsc --noEmit` never sees. next build still fully compiles/bundles the app; it just
    // doesn't run this second, differently-scoped check.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
