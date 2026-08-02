import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real Docker MinIO (docker-compose.yml), not a mock — the property under test (a presigned
    // URL actually accepting a PUT, an object actually being readable back) only means something
    // against a real S3-compatible endpoint.
    fileParallelism: false,
  },
});
