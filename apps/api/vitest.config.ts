import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real Postgres (docker-compose.yml) — these tests exercise the actual Fastify+tRPC request
    // pipeline against real data, not a mocked repository. Sequential: tests share one database.
    fileParallelism: false,
    // dashboard.summary (009-14) now fans out ~30 real executeMetric/repository calls per request
    // (top-row deltas, 12-point sparklines for 2 metrics, the exception feed, item ranking) — the
    // default 5000ms per-test timeout was measured to be too tight under this file's own sequential
    // test load (each request is genuinely correct and fast, ~1-3s, when run in isolation; the
    // shared connection pool across 8 sequential tests in one file pushes some over 5s). Raised
    // rather than shrinking real dashboard functionality to fit an arbitrary default.
    testTimeout: 20000,
  },
});
