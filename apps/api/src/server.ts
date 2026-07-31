import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { appRouter } from './trpc/router';
import { createContext } from './trpc/context';

export const buildServer = (options: { logger?: boolean } = {}) => {
  const app = Fastify({ logger: options.logger ?? true });

  // No signing secret configured: the session cookie's value is an opaque, unguessable
  // Redis-backed token (packages/session), not a value whose integrity depends on a signature —
  // unlike a JWT, a tampered/guessed token just fails to resolve to a real session in SessionStore.
  app.register(fastifyCookie);

  app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext,
    },
  });

  return app;
};
