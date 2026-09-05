import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    /**
     * These are real integration tests against a real Postgres — a sweep processor test seeds an
     * org, stores, products, lots and movements, runs the sweep, then tears it all down in FK
     * order. Measured honestly, the slower ones take 8-17s each; vitest's 5s default failed them
     * as "timeouts" while the code was working correctly, which is a false signal that trains
     * people to ignore red tests.
     *
     * 60s is a real ceiling, not a blanket suppression: a genuine hang (a lock, a runaway query)
     * still fails, just not on the normal cost of touching a database.
     */
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
