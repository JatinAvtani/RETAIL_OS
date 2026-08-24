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
