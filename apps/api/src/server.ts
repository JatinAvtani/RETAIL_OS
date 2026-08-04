import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { appRouter } from './trpc/router';
import { createContext } from './trpc/context';
import { registerGoogleOAuthRoutes } from './oauth/routes';
import { registerSquareOAuthRoutes } from './oauth/square-routes';

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';

export const buildServer = (options: { logger?: boolean } = {}) => {
  const app = Fastify({ logger: options.logger ?? true });

  // No signing secret configured: the session cookie's value is an opaque, unguessable
  // Redis-backed token (packages/session), not a value whose integrity depends on a signature —
  // unlike a JWT, a tampered/guessed token just fails to resolve to a real session in SessionStore.
  app.register(fastifyCookie);

  // credentials: true (not '*') is required for the browser to send/receive the __Host-session
  // cookie cross-origin (apps/web on :3000, apps/api on :3001) — the fetch spec forbids
  // credentialed requests from echoing a wildcard origin, so this must be one explicit origin.
  app.register(fastifyCors, { origin: WEB_ORIGIN, credentials: true });

  app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext,
    },
  });

  // Plain routes, not tRPC — OAuth's browser-redirect flow has no clean tRPC representation.
  registerGoogleOAuthRoutes(app);
  registerSquareOAuthRoutes(app);

  return app;
};
