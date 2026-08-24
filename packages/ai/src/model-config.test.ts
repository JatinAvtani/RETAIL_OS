import { describe, expect, it } from 'vitest';
import { MODEL_CONFIG, modelForTask } from './model-config';

describe('modelForTask', () => {
  it('returns a real flash-tier model for every task — none are pro-tier (this key has zero pro quota)', () => {
    for (const model of Object.values(MODEL_CONFIG)) {
      expect(model).toMatch(/flash/);
      expect(model).not.toMatch(/pro/);
    }
  });

  it('CLASSIFY uses the cheapest/fastest lite variant', () => {
    expect(modelForTask('CLASSIFY')).toBe('gemini-flash-lite-latest');
  });

  /**
   * Every task is on the lite variant as of 2026-08-24, and that is a deliberate availability
   * decision rather than a preference: `gemini-flash-latest` returned a persistent
   * `503 UNAVAILABLE — "experiencing high demand"` on this key, taking 45-67 SECONDS to do so,
   * which is far past the chat provider's 15s request timeout — so an overloaded model surfaced as
   * an opaque hang instead of the "model unavailable" error the app already handles. Narration
   * quality on the replacement was verified against a real grounding bundle before switching.
   *
   * This asserts the CURRENT deliberate configuration. If `-latest` recovers and PLAN/NARRATE move
   * back, update this test with a fresh live measurement — do not relax it into a loose pattern,
   * because the point is that a silent model change gets noticed.
   */
  it('PLAN and NARRATE use the lite flash variant — the non-lite variant is 503-unavailable on this key', () => {
    expect(modelForTask('PLAN')).toBe('gemini-flash-lite-latest');
    expect(modelForTask('NARRATE')).toBe('gemini-flash-lite-latest');
  });
});
