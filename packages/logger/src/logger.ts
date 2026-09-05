import { randomUUID } from 'node:crypto';
import pino, { type Logger } from 'pino';

/**
 * The one real structured logger for the whole system — previously every process (`apps/api`,
 * `apps/worker`) only had raw `console.log`/`console.error` calls: no log level, no JSON structure
 * a real log aggregator could parse, and critically no way to trace a single request or job across
 * the multiple `console.error` lines a failure typically produces. Pino (not winston/bunyan) because
 * it's the fastest structured logger with zero required infrastructure — this writes newline-
 * delimited JSON to stdout, same as `console.log` always did, so it costs nothing new to run
 * locally and is immediately ingestible by any real log platform later without a code change.
 *
 * `pino-pretty` is intentionally NOT wired here even in development — this project already runs
 * `apps/worker`'s output through plain terminal reading, and raw JSON lines are more useful when
 * grepping for a specific `requestId` than a colorized multi-line format would be.
 */
export const baseLogger: Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: null, // Drops pino's default pid/hostname fields — noise in a single-instance dev/demo deployment with no fleet to distinguish.
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * A fresh correlation id for one request or one background job — the SAME id must be threaded
 * through every log line that request/job produces (via `logger.child({ requestId })`), which is
 * what actually makes "find every log line for this one failure" possible. Not derived from
 * anything upstream (no incoming `x-request-id` header trust) — this process always mints its own,
 * matching a request/job's own natural unit-of-work boundary.
 */
export const generateRequestId = (): string => randomUUID();

/** Binds a `requestId` (and any other fixed fields) to every subsequent log call on the returned child — the correlation mechanism itself. */
export const withRequestId = (requestId: string, extra?: Record<string, unknown>): Logger =>
  baseLogger.child({ requestId, ...extra });

/**
 * A BullMQ job's `failed` handler previously always ended in `console.error(...err.message)` —
 * dropping the stack trace, the job's own data, and any way to grep a fleet of interleaved worker
 * output for one specific job's failure. `jobId` doubles as the correlation id here (already unique
 * per job, and BullMQ's dashboard/logs already key on it), so this does not mint a fresh
 * `generateRequestId()` the way an inbound HTTP request does. `err` passed as a field (not
 * interpolated into the message) is what lets pino serialize the full stack, matching this
 * function's whole reason for existing over the old plain-string `console.error` call.
 */
export const logJobFailure = (queueName: string, jobId: string | undefined, jobData: unknown, err: Error): void => {
  baseLogger.error({ queueName, jobId, jobData, err }, `${queueName} job failed`);
};
