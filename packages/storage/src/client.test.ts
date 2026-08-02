import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPresignedDownloadUrl,
  createPresignedUploadUrl,
  createStorageClient,
  ensureBucketExists,
  getObjectBytes,
} from './client';
import { buildProductImageKey } from './object-key';

const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
const ACCESS_KEY = process.env.S3_ACCESS_KEY ?? 'minioadmin';
const SECRET_KEY = process.env.S3_SECRET_KEY ?? 'minioadmin';
const BUCKET = 'retailos-storage-test';

/**
 * Real Docker MinIO, not a mock — the property under test (a presigned URL genuinely accepting an
 * HTTP PUT from a plain fetch call, with no SDK/credentials on the client side) only means
 * something against a real S3-compatible server.
 */
describe('storage client', () => {
  const client = createStorageClient({
    endpoint: ENDPOINT,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    bucket: BUCKET,
  });

  beforeAll(async () => {
    await ensureBucketExists(client, BUCKET);
  });

  afterAll(() => {
    client.destroy();
  });

  it('ensureBucketExists is idempotent — calling it again on an existing bucket does not throw', async () => {
    await expect(ensureBucketExists(client, BUCKET)).resolves.toBeUndefined();
  });

  it('a presigned upload URL accepts a real PUT with no SDK/credentials on the caller side', async () => {
    const key = buildProductImageKey('test-org', 'test-product', 'jpg');
    const uploadUrl = await createPresignedUploadUrl(client, BUCKET, key, 'image/jpeg');
    const fakeJpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: fakeJpegBytes,
    });

    expect(response.ok).toBe(true);
  });

  it('the uploaded object is readable back with the exact bytes that were sent', async () => {
    const key = buildProductImageKey('test-org', 'test-product-2', 'png');
    const uploadUrl = await createPresignedUploadUrl(client, BUCKET, key, 'image/png');
    const originalBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: originalBytes,
    });

    const readBack = await getObjectBytes(client, BUCKET, key);
    expect(readBack.equals(originalBytes)).toBe(true);
  });

  it('a presigned download URL serves the object over plain HTTP with no credentials', async () => {
    const key = buildProductImageKey('test-org', 'test-product-3', 'jpg');
    const uploadUrl = await createPresignedUploadUrl(client, BUCKET, key, 'image/jpeg');
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: bytes });

    const downloadUrl = await createPresignedDownloadUrl(client, BUCKET, key);
    const response = await fetch(downloadUrl);
    const downloaded = Buffer.from(await response.arrayBuffer());

    expect(response.ok).toBe(true);
    expect(downloaded.equals(bytes)).toBe(true);
  });

  it('a presigned upload URL rejects a PUT after it expires', async () => {
    const key = buildProductImageKey('test-org', 'test-product-expired', 'jpg');
    const uploadUrl = await createPresignedUploadUrl(client, BUCKET, key, 'image/jpeg', 1);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: Buffer.from([0xff, 0xd8]),
    });

    expect(response.ok).toBe(false);
  });
});
