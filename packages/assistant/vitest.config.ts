import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Most of this package's tests are pure and fast, but `execute-selections.test.ts` runs real
     * metric execution against the real Docker Postgres — seeding an org, store and movements, then
     * executing a registered metric end to end. Measured at ~6.7s against a warm database, which
     * vitest's 5s default failed as a "timeout" while the code was working correctly.
     *
     * 30s is a real ceiling, not a blanket suppression: a genuine hang (a lock, a runaway query)
     * still fails the suite, just not the ordinary cost of touching a database.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
