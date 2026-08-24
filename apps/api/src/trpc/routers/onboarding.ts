import { z } from 'zod';
import { OnboardingRepository } from '@retailos/db';
import { protectedProcedure, router } from '../trpc';
import { computeRealOnboardingHealth } from '../../integrations/onboarding-health';

const stepNames = ['salesConnectedStatus', 'invoicesUploadedStatus', 'entitiesConfirmedStatus', 'parLevelsSetStatus'] as const;

const setStepInput = z.object({
  step: z.enum(stepNames),
  status: z.enum(['DONE', 'SKIPPED']),
});

/**
 * The guided setup wizard's own progress (spec 03 M9) — org creation and the first store are
 * already real by the time any caller reaches this router (`auth.signup` creates both), so the
 * tracked steps start from "connect sales." No permission gate beyond a valid session: this is the
 * caller's own org's setup state, not sensitive business data, and every OWNER/MANAGER/STAFF
 * reaching a fresh org needs to see and drive it, matching `notifications.getPreferences`'s own
 * "always the caller's own row" precedent.
 */
export const onboardingRouter = router({
  getProgress: protectedProcedure.query(async ({ ctx }) => {
    const onboardingRepository = new OnboardingRepository(ctx.db, ctx.session.organizationId);
    return onboardingRepository.findOrCreate();
  }),

  setStepStatus: protectedProcedure.input(setStepInput).mutation(async ({ ctx, input }) => {
    const onboardingRepository = new OnboardingRepository(ctx.db, ctx.session.organizationId);
    return onboardingRepository.setStepStatus(input.step, input.status);
  }),

  dismiss: protectedProcedure.mutation(async ({ ctx }) => {
    const onboardingRepository = new OnboardingRepository(ctx.db, ctx.session.organizationId);
    await onboardingRepository.dismiss();
    return { message: 'Dismissed.' };
  }),

  /**
   * the health score the plan's own `OnboardingHealth` shape names — computed fresh on
   * every call from real current data across every real table it draws from, never cached or
   * persisted (matching detection's own "recomputed fresh" precedent). Same
   * "caller's own org, no *Id input" shape as `getProgress` — correctly exempt from the
   * cross-tenant registry, same reasoning as that procedure.
   */
  getHealth: protectedProcedure.query(async ({ ctx }) => {
    return computeRealOnboardingHealth(ctx.db, ctx.session.organizationId);
  }),
});
