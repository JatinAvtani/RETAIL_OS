import { initTRPC } from '@trpc/server';
import type { Context } from './context';

const t = initTRPC.context<Context>().create({
  // Stack traces are useful in local dev but must never reach a real client — leaking internal
  // file paths and call stacks is an information-disclosure issue, not a cosmetic one.
  errorFormatter: ({ shape }) => ({
    ...shape,
    data: {
      ...shape.data,
      stack: undefined,
    },
  }),
});

export const router = t.router;
export const publicProcedure = t.procedure;
