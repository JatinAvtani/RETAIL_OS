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
    expect(modelForTask('CLASSIFY')).toBe('gemini-3.1-flash-lite');
  });

  /**
   * Every task is on the lite variant as of 2026-08-24 (a deliberate availability decision:
   * `gemini-flash-latest` returned a persistent `503 UNAVAILABLE` on this key, taking 45-67 SECONDS
   * to do so — far past the chat provider's 15s request timeout). As of 2026-09-04, all three tasks
   * moved from the `-latest` ALIAS to the real, versioned `gemini-3.1-flash-lite` tag — a floating
   * alias lets Google silently swap the underlying model with no warning; a versioned tag cannot
   * move underneath the app the same way, even though it will eventually be retired outright (as
   * already happened to `gemini-2.5-flash-lite`). Narration/classification/vision-extraction
   * quality on the replacement was verified live before switching (see model-config.ts's own doc
   * comment for the measurements).
   *
   * This asserts the CURRENT deliberate configuration. If this tag is ever retired and a
   * replacement is chosen, update this test with a fresh live measurement — do not relax it into a
   * loose pattern, because the point is that a silent model change gets noticed.
   */
  it('PLAN and NARRATE use the lite flash variant — the non-lite variant is 503-unavailable on this key', () => {
    expect(modelForTask('PLAN')).toBe('gemini-3.1-flash-lite');
    expect(modelForTask('NARRATE')).toBe('gemini-3.1-flash-lite');
  });
});
