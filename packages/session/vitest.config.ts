import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real Docker Redis (docker-compose.yml), not a mock — the property under test (TTL behavior,
    // atomic multi/exec, revocation) only means something against a real Redis. Sequential: tests
    // share one Redis instance and clean up their own keys.
    fileParallelism: false,
  },
});
