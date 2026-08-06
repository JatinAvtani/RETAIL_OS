import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real Redis (docker-compose.yml) — BullMQ's actual queue/worker mechanics only mean
    // something against a real Redis instance, not a mock.
    fileParallelism: false,
  },
});
