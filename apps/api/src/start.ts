// First import, for the same reason as the worker: `./server` and its transitive imports read
// `process.env` during module evaluation, which happens before any statement in this file's body.
import '@retailos/config/auto';
import { buildServer } from './server';

const app = buildServer();
const port = Number(process.env.PORT ?? 3001);

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

/**
 * Graceful shutdown: `Fastify.close()` stops accepting new connections and waits for in-flight
 * requests to finish before resolving (Fastify's own documented contract) — a signal-driven
 * `process.exit()` with no `close()` call would cut off a request mid-transaction (e.g. a document
 * approval or PO transition mid-write) instead of letting it complete or fail cleanly.
 */
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return; // a second SIGTERM/SIGINT while already draining must not re-enter this
  shuttingDown = true;
  app.log.info(`${signal} received — closing the server (waiting for in-flight requests to finish)...`);
  try {
    await app.close();
    app.log.info('Server shutdown complete.');
    process.exit(0);
  } catch (err) {
    app.log.error(err, 'Server failed to close cleanly.');
    process.exit(1);
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Never silently swallowed and never a silent crash either — logged with full context so a real
// failure (a promise rejection nothing in this codebase awaited) is visible in whatever collects
// this process's logs.
process.on('unhandledRejection', (reason) => {
  app.log.error(reason, 'Unhandled promise rejection in API process.');
});
