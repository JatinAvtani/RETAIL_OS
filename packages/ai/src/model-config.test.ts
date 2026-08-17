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

  it('PLAN and NARRATE use the same, more capable non-lite flash variant', () => {
    expect(modelForTask('PLAN')).toBe('gemini-flash-latest');
    expect(modelForTask('NARRATE')).toBe('gemini-flash-latest');
  });
});
