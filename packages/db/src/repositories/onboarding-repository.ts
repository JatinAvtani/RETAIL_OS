import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { onboardingProgress, type OnboardingStepStatus } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

export type OnboardingStepName =
  | 'salesConnectedStatus'
  | 'invoicesUploadedStatus'
  | 'entitiesConfirmedStatus'
  | 'parLevelsSetStatus';

/**
 * Every org that signed up before this migration has no `onboarding_progress` row at all — rather
 * than a nullable-everywhere caller-side check, `findOrCreate` guarantees a real row exists (all
 * steps PENDING) the first time any caller asks, matching `NotificationPreferenceRepository.
 * findOrDefaultForUser`'s own established precedent for this exact "give every caller a real row,
 * lazily" shape.
 */
export class OnboardingRepository extends TenantScopedRepository<typeof onboardingProgress> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, onboardingProgress, organizationId);
  }

  /**
   * a read that must NOT create a row as a side effect of merely being viewed — the health
   * score reads `updatedAt` to detect a stalled org, but a brand-new org that has never touched the
   * wizard at all is a genuinely different state from one that started and went quiet, and creating
   * a fresh PENDING row here would collapse that distinction the moment anyone's health score is
   * first computed (I7). `findOrCreate` remains reserved for the wizard's own real step writes.
   */
  async findExistingOrNull() {
    const rows = await this.runScoped((db, scopedWhere) =>
      db.select().from(onboardingProgress).where(scopedWhere(eq(onboardingProgress.organizationId, this.organizationId)))
    );
    return rows[0] ?? null;
  }

  async findOrCreate() {
    const existing = await this.runScoped((db, scopedWhere) =>
      db.select().from(onboardingProgress).where(scopedWhere(eq(onboardingProgress.organizationId, this.organizationId)))
    );
    if (existing[0]) {
      return existing[0];
    }

    const id = generateId();
    const rows = await this.runScoped((db) =>
      db
        .insert(onboardingProgress)
        .values({ id, organizationId: this.organizationId })
        // A concurrent first-call race (two requests both miss the SELECT above) resolves to
        // whichever insert wins, not a duplicate-key crash for the loser.
        .onConflictDoUpdate({
          target: onboardingProgress.organizationId,
          set: { updatedAt: new Date() },
        })
        .returning()
    );
    const row = rows[0];
    if (!row) {
      throw new Error('Onboarding progress creation returned no row.');
    }
    return row;
  }

  async setStepStatus(step: OnboardingStepName, status: OnboardingStepStatus) {
    await this.findOrCreate();
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(onboardingProgress)
        .set({ [step]: status, updatedAt: new Date() })
        .where(scopedWhere(eq(onboardingProgress.organizationId, this.organizationId)))
        .returning()
    );
    const row = rows[0];
    if (!row) {
      throw new Error('Onboarding progress update returned no row.');
    }
    return row;
  }

  async dismiss() {
    await this.findOrCreate();
    await this.runScoped((db, scopedWhere) =>
      db
        .update(onboardingProgress)
        .set({ dismissed: true, updatedAt: new Date() })
        .where(scopedWhere(eq(onboardingProgress.organizationId, this.organizationId)))
    );
  }
}
