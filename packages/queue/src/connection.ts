import Redis from 'ioredis';

/**
 * BullMQ's own documented requirement (confirmed against their real source, not guessed) —
 * a `Worker`'s internal blocking connection requires `maxRetriesPerRequest: null`; passing an
 * already-constructed `ioredis` instance with anything else set causes BullMQ to throw at
 * construction time. `Queue` accepts the same instance fine — a queue "add" is a fire-and-forget
 * write, no blocking involved, so nothing about this setting weakens its own behavior. One shared
 * connection, not two, mirrors `packages/session`'s own `createRedisClient` shape.
 */
export const createQueueRedisConnection = (url: string): Redis => new Redis(url, { maxRetriesPerRequest: null });
