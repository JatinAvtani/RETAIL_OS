import { describe, expect, it } from 'vitest';
import { computeOnboardingHealth, type OnboardingHealthInputs } from './health-score.js';

const NOW = new Date('2026-08-23T12:00:00Z');

const FULLY_HEALTHY: OnboardingHealthInputs = {
  storeCreated: true,
  salesConnected: true,
  invoicesUploadedAtLeast30Days: true,
  productsConfirmedRatio: 0.9,
  suppliersConfirmedRatio: 0.85,
  posItemsMappedRatioByVolume: 0.95,
  recipesCreated: { withRecipe: 18, topMenuItemCount: 20 },
  parLevelsSet: { fullyCovered: 17, recipeCoveredMenuItemCount: 18 },
  onboardingProgressUpdatedAt: NOW,
  now: NOW,
};

const BRAND_NEW: OnboardingHealthInputs = {
  storeCreated: true,
  salesConnected: false,
  invoicesUploadedAtLeast30Days: false,
  productsConfirmedRatio: null,
  suppliersConfirmedRatio: null,
  posItemsMappedRatioByVolume: null,
  recipesCreated: { withRecipe: 0, topMenuItemCount: 0 },
  parLevelsSet: { fullyCovered: 0, recipeCoveredMenuItemCount: 0 },
  onboardingProgressUpdatedAt: null,
  now: NOW,
};

describe('computeOnboardingHealth', () => {
  it('a fully-healthy org scores 100 with no blockers', () => {
    const health = computeOnboardingHealth(FULLY_HEALTHY);
    expect(health.score).toBe(100);
    expect(health.blockers).toHaveLength(0);
    expect(health.stalled).toBe(false);
  });

  it('a brand-new org with only a store scores 12 (1 of 8 steps done) with real blockers', () => {
    const health = computeOnboardingHealth(BRAND_NEW);
    expect(health.score).toBe(13); // 1/8 = 0.125 -> rounds to 13
    expect(health.steps.storeCreated.done).toBe(true);
    expect(health.steps.salesConnected.done).toBe(false);
    expect(health.blockers).toContain('No sales source (POS or CSV import) is connected yet.');
  });

  it('a brand-new org (no onboarding_progress row yet) is never "stalled" — it has not started, not gone quiet', () => {
    const health = computeOnboardingHealth(BRAND_NEW);
    expect(health.stalled).toBe(false);
  });

  it('null ratio steps (nothing to measure yet) never appear as blockers — there is nothing actionable to report', () => {
    const health = computeOnboardingHealth(BRAND_NEW);
    expect(health.blockers.some((b) => b.includes('%'))).toBe(false);
    expect(health.steps.productsConfirmed.ratio).toBeNull();
    expect(health.steps.productsConfirmed.done).toBe(false);
  });

  it('a ratio exactly at the 80% threshold counts as done', () => {
    const health = computeOnboardingHealth({ ...FULLY_HEALTHY, productsConfirmedRatio: 0.8 });
    expect(health.steps.productsConfirmed.done).toBe(true);
  });

  it('a ratio just below the 80% threshold does not count as done, and produces a real blocker with the real percentage', () => {
    const health = computeOnboardingHealth({ ...FULLY_HEALTHY, productsConfirmedRatio: 0.79 });
    expect(health.steps.productsConfirmed.done).toBe(false);
    expect(health.blockers.some((b) => b.includes('79%'))).toBe(true);
  });

  it('stalled is true when onboarding_progress has not moved in 3+ days and the org is not yet at 100%', () => {
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    const health = computeOnboardingHealth({ ...BRAND_NEW, onboardingProgressUpdatedAt: threeDaysAgo });
    expect(health.stalled).toBe(true);
  });

  it('stalled is false when onboarding_progress moved less than 3 days ago', () => {
    const oneDayAgo = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000);
    const health = computeOnboardingHealth({ ...BRAND_NEW, onboardingProgressUpdatedAt: oneDayAgo });
    expect(health.stalled).toBe(false);
  });

  it('stalled is false once an org reaches a perfect score, even with old activity — nothing left to rescue', () => {
    const tenDaysAgo = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
    const health = computeOnboardingHealth({ ...FULLY_HEALTHY, onboardingProgressUpdatedAt: tenDaysAgo });
    expect(health.score).toBe(100);
    expect(health.stalled).toBe(false);
  });

  it('recipesCreated with zero top menu items (no sales yet) is a real null ratio, not a fabricated 0% or 100%', () => {
    const health = computeOnboardingHealth(BRAND_NEW);
    expect(health.steps.recipesCreated.ratio).toBeNull();
  });

  it('parLevelsSet with zero recipe-covered menu items is also a real null ratio', () => {
    const health = computeOnboardingHealth(BRAND_NEW);
    expect(health.steps.parLevelsSet.ratio).toBeNull();
  });

  it('every step weighs equally toward the score — 4 of 8 done scores 50', () => {
    const health = computeOnboardingHealth({
      ...BRAND_NEW,
      salesConnected: true,
      invoicesUploadedAtLeast30Days: true,
      productsConfirmedRatio: 1,
    });
    // storeCreated + salesConnected + invoicesUploaded + productsConfirmed = 4/8
    expect(health.score).toBe(50);
  });
});
