import { eq } from 'drizzle-orm';
import { organizations } from '@retailos/db';
import type { CurrencyCode } from '@retailos/domain';
import type { MetricContext } from './types.js';

/**
 * The org's real base currency. Every catalog module previously hardcoded a module-level
 * `CURRENCY = 'USD'` constant, silently mislabeling every money figure for any org whose
 * `organizations.baseCurrency` is something else — a real bug (I5/I7-adjacent: a currency amount
 * is only correct paired with its real unit), not a refactor. `MetricContext` already carries
 * `db`/`organizationId` for exactly this lookup — matches `apps/api/src/trpc/routers/recipes.ts`'s
 * own established pattern for the same column, just usable from every catalog module instead of
 * being duplicated at each call site.
 */
export const resolveCurrency = async (ctx: MetricContext): Promise<CurrencyCode> => {
  const [orgRow] = await ctx.db
    .select({ baseCurrency: organizations.baseCurrency })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId));
  return (orgRow?.baseCurrency ?? 'USD') as CurrencyCode;
};
