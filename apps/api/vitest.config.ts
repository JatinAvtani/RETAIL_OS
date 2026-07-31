import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real Postgres (docker-compose.yml) — these tests exercise the actual Fastify+tRPC request
    // pipeline against real data, not a mocked repository. Sequential: tests share one database.
    fileParallelism: false,
  },
});
