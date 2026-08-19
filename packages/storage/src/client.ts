import {
  CreateBucketCommand,
  HeadBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type StorageClientOptions = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** MinIO needs path-style addressing (bucket.endpoint doesn't resolve locally); real S3 doesn't. */
  forcePathStyle?: boolean;
  region?: string;
};

/**
 * Thin wrapper around the S3 SDK, same shape as `packages/session`'s `createRedisClient` — one
 * function returning one long-lived client, no attempt to abstract away which object-storage
 * provider is behind it. MinIO is S3-compatible, so this is the same client used against real S3
 * in production; only `endpoint`/`forcePathStyle` differ between environments.
 */
export const createStorageClient = (options: StorageClientOptions): S3Client =>
  new S3Client({
    endpoint: options.endpoint,
    region: options.region ?? 'us-east-1',
    forcePathStyle: options.forcePathStyle ?? true,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });

/**
 * Idempotent — safe to call on every process start (mirrors this project's `CREATE... IF NOT
 * EXISTS` migration convention). No bucket-creation step exists anywhere else (docker-compose.yml
 * starts MinIO with zero buckets), so something has to create it before first use.
 */
export const ensureBucketExists = async (client: S3Client, bucket: string): Promise<void> => {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
};

/**
 * the design/: object storage paths are tenant-prefixed, and uploads go via presigned
 * URLs, never proxied through the API. `contentType` is bound into the signature so the presigned
 * URL only accepts a PUT declaring the type the caller asked to upload as — the object's actual
 * bytes are still verified server-side after upload (see `verifyImageMagicBytes`), since a
 * presigned content-type is caller-declared, not proof of what was actually sent.
 */
export const createPresignedUploadUrl = async (
  client: S3Client,
  bucket: string,
  key: string,
  contentType: string,
  expiresInSeconds = 300
): Promise<string> => {
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
};

/** the design: objects are never public — every read goes through a short-lived presigned URL. */
export const createPresignedDownloadUrl = async (
  client: S3Client,
  bucket: string,
  key: string,
  expiresInSeconds = 300
): Promise<string> => {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
};

/**
 * Direct server-side write — unlike every other upload path in this project (presigned URL, bytes
 * travel browser-to-S3 directly, the design's "never proxy large files through the API"), an
 * inbound email webhook's attachment bytes arrive to the API itself as part of the verified webhook
 * payload — there is no browser in this flow to hand a presigned URL to. The size/type
 * constraints this project applies elsewhere (magic-byte verification, size caps) are still enforced
 * by the CALLER before this is invoked; this function only performs the write.
 */
export const putObjectBytes = async (client: S3Client, bucket: string, key: string, bytes: Buffer, contentType: string): Promise<void> => {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }));
};

/** Fetches the object's actual bytes for server-side verification (magic bytes, size). */
export const getObjectBytes = async (client: S3Client, bucket: string, key: string): Promise<Buffer> => {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = result.Body;
  if (!body) {
    throw new Error(`Object '${key}' in bucket '${bucket}' has no body.`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};
