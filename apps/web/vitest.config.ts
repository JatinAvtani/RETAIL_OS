import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // Mirrors the `@/*` path alias in tsconfig.json, so a test importing `@/lib/format` resolves the
    // same way the Next.js build does. Without it the alias is a runtime-only Next concern and every
    // aliased import fails under vitest.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // Unlike apps/api, nothing here touches Postgres — these cover pure presentation helpers
    // (money formatting, decimal arithmetic on strings), so the default parallelism and timeouts
    // are fine. Component tests would need jsdom; none exist yet, so none is configured.
    include: ['src/**/*.test.ts'],
  },
});
