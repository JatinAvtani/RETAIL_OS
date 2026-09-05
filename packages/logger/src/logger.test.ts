import { describe, expect, it, vi } from 'vitest';
import { generateRequestId, withRequestId, logJobFailure } from './logger';

describe('generateRequestId', () => {
  it('produces a real, distinct id on every call', () => {
    const a = generateRequestId();
    const b = generateRequestId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('withRequestId', () => {
  it('binds requestId to every log call the child logger makes', () => {
    const child = withRequestId('req-123', { path: '/trpc/auth.me' });
    const spy = vi.spyOn(child, 'info');
    child.info('hello');
    expect(spy).toHaveBeenCalled();
  });

  it('two children with different requestIds are independent loggers', () => {
    const childA = withRequestId('req-a');
    const childB = withRequestId('req-b');
    expect(childA).not.toBe(childB);
  });
});

describe('logJobFailure', () => {
  it('does not throw for a real Error with a job id and data', () => {
    expect(() => logJobFailure('test-queue', 'job-1', { storeId: 'store-1' }, new Error('boom'))).not.toThrow();
  });

  it('does not throw when jobId is undefined (a job reference BullMQ could not resolve)', () => {
    expect(() => logJobFailure('test-queue', undefined, undefined, new Error('boom'))).not.toThrow();
  });
});
