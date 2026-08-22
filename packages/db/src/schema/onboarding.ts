import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

/**
 * One row per org. Each named step is a real, independently skippable/resumable stage of the
 * guided setup wizard (spec 03 M9) — never a single "completed" boolean, since the wizard's whole
 * design point is that a step can be skipped now and finished later without losing the steps
 * already done. `salesConnected`/`invoicesUploaded`/`entitiesConfirmed`/`parLevelsSet` are each a
 * plain status, not a timestamp-implies-done pattern, because "skipped" and "not started" are both
 * real, distinguishable states a health score (012-08) will need later — collapsing them to a
 * boolean would lose that.
 */
export const onboardingStepStatusValues = ['PENDING', 'DONE', 'SKIPPED'] as const;
export type OnboardingStepStatus = (typeof onboardingStepStatusValues)[number];

export const onboardingProgress = pgTable(
  'onboarding_progress',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    salesConnectedStatus: text('sales_connected_status', { enum: onboardingStepStatusValues }).notNull().default('PENDING'),
    invoicesUploadedStatus: text('invoices_uploaded_status', { enum: onboardingStepStatusValues }).notNull().default('PENDING'),
    entitiesConfirmedStatus: text('entities_confirmed_status', { enum: onboardingStepStatusValues }).notNull().default('PENDING'),
    parLevelsSetStatus: text('par_levels_set_status', { enum: onboardingStepStatusValues }).notNull().default('PENDING'),
    dismissed: boolean('dismissed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgUnique: uniqueIndex('onboarding_progress_org_idx').on(table.organizationId),
  }),
);
