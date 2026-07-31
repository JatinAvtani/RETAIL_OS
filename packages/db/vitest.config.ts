import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These tests hit the real Docker Postgres (docker-compose.yml), not a mock or in-memory DB —
    // deliberately, since the property under test (RLS, tenant isolation) only exists in Postgres
    // itself. Sequential, not parallel: tests share one database and seed/clean up their own
    // tenants: safe to run repeatedly, but concurrent test files racing on the same connection
    // pool during setup/teardown is unnecessary risk for no speed benefit at this scale.
    fileParallelism: false,
  },
});
