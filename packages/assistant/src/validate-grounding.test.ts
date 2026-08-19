import { describe, expect, it, vi } from 'vitest';
import type { ChatProvider, ChatResult } from '@retailos/ai';
import { validateGrounding, narrateAndValidate } from './validate-grounding';
import type { GroundingBundle } from './grounding-bundle';

/**
 * ⚠️ THE CORE SAFETY MECHANISM. `validateGrounding` is pure and deterministic (no model
 * involvement) — these tests prove the real algorithm the design names: every numeric token in a
 * response must match a real bundle value (within formatting tolerance), or it's a violation.
 * `narrateAndValidate` tests the fail-closed regenerate-once/discard wrapper against a fake
 * `ChatProvider` that can be scripted to return a grounded or ungrounded response per call.
 */
const realMetric: GroundingBundle['metrics'][number] = {
  metricId: 'net_revenue',
  value: '1234.5600',
  unit: 'CURRENCY',
  period: { from: new Date('2026-08-01'), to: new Date('2026-08-31') },
  computedAt: new Date(),
  freshness: new Date(),
  provenance: [],
};

describe('validateGrounding', () => {
  it('a response citing the exact stored value is grounded', () => {
    const bundle: GroundingBundle = { metrics: [realMetric], passages: [], entities: [] };
    const result = validateGrounding('Your net revenue was 1234.5600.', bundle);
    expect(result).toEqual({ ok: true });
  });

  it('a response citing a rounded/thousands-separated variant is grounded — formatting tolerance', () => {
    const bundle: GroundingBundle = { metrics: [realMetric], passages: [], entities: [] };
    const result = validateGrounding('Your net revenue was $1,234.56.', bundle);
    expect(result).toEqual({ ok: true });
  });

  it('a response citing a genuinely fabricated number is a real violation — the core safety property', () => {
    const bundle: GroundingBundle = { metrics: [realMetric], passages: [], entities: [] };
    const result = validateGrounding('Your net revenue was 9999.99.', bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations).toEqual(['9999.99']);
  });

  it('a response deriving a NEW number by arithmetic from two real values is a real violation, not silently trusted', () => {
    const other: GroundingBundle['metrics'][number] = { ...realMetric, metricId: 'cogs_actual', value: '500.0000' };
    const bundle: GroundingBundle = { metrics: [realMetric, other], passages: [], entities: [] };
    // 1234.56 - 500 = 734.56, a real, plausible-looking number the model computed itself — never in the bundle
    const result = validateGrounding('Your margin was 734.56.', bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations).toEqual(['734.56']);
  });

  it('a real calendar date in the response is excluded, never flagged as a violation', () => {
    const bundle: GroundingBundle = { metrics: [realMetric], passages: [], entities: [] };
    const result = validateGrounding('As of August 31, 2026, your net revenue was 1234.5600.', bundle);
    expect(result).toEqual({ ok: true });
  });

  it('an unknown-valued metric contributes NOTHING to the allowlist — its own value string is never a real citable number', () => {
    const unknownMetric: GroundingBundle['metrics'][number] = { ...realMetric, metricId: 'margin_per_item', value: 'unknown', unknownReason: 'No recipe.' };
    const bundle: GroundingBundle = { metrics: [unknownMetric], passages: [], entities: [] };
    const result = validateGrounding('The margin is roughly unknown.', bundle);
    // "unknown" is not a numeric token at all, so this genuinely has no violations — the real
    // point of this test is that no number derived from "unknown" could ever be grounded.
    expect(result).toEqual({ ok: true });
  });

  it('a number embedded in a denied/failed/rejected reason string is NOT added to the allowlist by validateGrounding itself — it only reads bundle.metrics', () => {
    // validateGrounding takes only a bundle, never denied/failed/rejected — this test documents
    // that boundary explicitly: a reason string like "limit: 100" must not leak into the allowlist
    // via any hidden path.
    const bundle: GroundingBundle = { metrics: [], passages: [], entities: [] };
    const result = validateGrounding('The limit is 100.', bundle);
    expect(result.ok).toBe(false);
  });

  it('an empty bundle with a response containing no numbers at all is grounded — a real "insufficient data" narration', () => {
    const bundle: GroundingBundle = { metrics: [], passages: [], entities: [] };
    const result = validateGrounding("I don't have enough information to answer that.", bundle);
    expect(result).toEqual({ ok: true });
  });
});

const fakeProviderSequence = (results: ChatResult[]): ChatProvider => {
  const generate = vi.fn();
  for (const r of results) generate.mockResolvedValueOnce(r);
  return { name: 'fake', generate, generateStructured: vi.fn() };
};

const ok = (text: string): ChatResult => ({ provider: 'fake', modelVersion: 'fake-model', latencyMs: 1, error: null, text });
const failed = (error: string): ChatResult => ({ provider: 'fake', modelVersion: 'fake-model', latencyMs: 1, error, text: null });

describe('narrateAndValidate — the fail-closed wrapper', () => {
  const bundle: GroundingBundle = { metrics: [realMetric], passages: [], entities: [] };

  it('a grounded first attempt is served directly, no regeneration needed', async () => {
    const provider = fakeProviderSequence([ok('Your net revenue was 1234.5600.')]);

    const result = await narrateAndValidate(provider, bundle, [], [], [], 'fake-model');

    expect(result).toEqual({ text: 'Your net revenue was 1234.5600.', grounded: true, violationLog: [] });
  });

  it('an ungrounded first attempt triggers exactly one regeneration, and a grounded second attempt is served', async () => {
    const provider = fakeProviderSequence([ok('Your net revenue was 9999.99.'), ok('Your net revenue was 1234.5600.')]);

    const result = await narrateAndValidate(provider, bundle, [], [], [], 'fake-model');

    expect(result.grounded).toBe(true);
    expect(result.text).toBe('Your net revenue was 1234.5600.');
    expect(result.violationLog).toHaveLength(1);
    expect(result.violationLog[0]?.violations).toEqual(['9999.99']);
  });

  it('two consecutive violations DISCARD the prose entirely — never serve an ungrounded response', async () => {
    const provider = fakeProviderSequence([ok('Your net revenue was 9999.99.'), ok('Your net revenue was 8888.88.')]);

    const result = await narrateAndValidate(provider, bundle, [], [], [], 'fake-model');

    expect(result.grounded).toBe(false);
    expect(result.text).toBeNull();
    expect(result.violationLog).toHaveLength(2);
  });

  it('the second attempt uses the strict prompt addendum — confirmed by inspecting the real call', async () => {
    const generate = vi.fn().mockResolvedValueOnce(ok('9999.99')).mockResolvedValueOnce(ok('1234.5600'));
    const provider: ChatProvider = { name: 'fake', generate, generateStructured: vi.fn() };

    await narrateAndValidate(provider, bundle, [], [], [], 'fake-model');

    const [secondPrompt] = generate.mock.calls[1] as [string, string];
    expect(secondPrompt.toLowerCase()).toContain('serious error');
  });

  it('a provider error on the first attempt discards immediately — never retries a call that never even returned text', async () => {
    const generate = vi.fn().mockResolvedValueOnce(failed('503 Service Unavailable'));
    const provider: ChatProvider = { name: 'fake', generate, generateStructured: vi.fn() };

    const result = await narrateAndValidate(provider, bundle, [], [], [], 'fake-model');

    expect(result).toEqual({ text: null, grounded: false, violationLog: [] });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('a provider error on the SECOND (retry) attempt also discards, never serves the first violating response instead', async () => {
    const provider = fakeProviderSequence([ok('Your net revenue was 9999.99.'), failed('504 Deadline Exceeded')]);

    const result = await narrateAndValidate(provider, bundle, [], [], [], 'fake-model');

    expect(result.text).toBeNull();
    expect(result.grounded).toBe(false);
  });
});

/**
 * Adversarial responses — each of these once PASSED validation. They are the bypasses found by
 * attacking the validator with a response deliberately built to smuggle a fabricated figure past
 * it, and they stay here as regression armour: every case asserts the fabrication is now caught.
 * The one bypass that deliberately remains open (numbers written out as words) is asserted as
 * such at the bottom, so the boundary of what this validator guarantees is tested, not implied.
 */
describe('validateGrounding — adversarial responses', () => {
  const bundle: GroundingBundle = {
    metrics: [{ ...realMetric, value: '1000.00' }],
    passages: [],
    entities: [],
  };

  it('a fabricated figure inside double quotes is a violation — quoting does not launder a number', () => {
    const result = validateGrounding('Your margin was "4200" this month.', bundle);
    expect(result.ok).toBe(false);
  });

  it('an apostrophe earlier in the sentence does not open a span that hides later figures', () => {
    // The old quoted-span rule treated the apostrophe in "store's" as an opening single quote,
    // swallowing every number after it for the rest of the response.
    const result = validateGrounding("The store's margin was 4200 and it's rising.", bundle);
    expect(result).toEqual({ ok: false, violations: ['4200'] });
  });

  it('a 4-digit figure wearing an ordinal suffix is a violation — real ordinals stay small', () => {
    const result = validateGrounding('You ranked 4200th in cost.', bundle);
    expect(result.ok).toBe(false);
  });

  it('a genuine small ordinal is still excluded, not flagged', () => {
    const result = validateGrounding('Your top item held 1st place; revenue was 1000.00.', bundle);
    expect(result).toEqual({ ok: true });
  });

  it('a sign-flipped figure is a violation — -1000.00 is not the bundle value 1000.00', () => {
    const result = validateGrounding('Your margin was -1000.00 this month.', bundle);
    expect(result).toEqual({ ok: false, violations: ['-1000.00'] });
  });

  it('a genuinely negative bundle value validates with its sign, and its sign-dropped form does not', () => {
    const negativeBundle: GroundingBundle = {
      metrics: [{ ...realMetric, metricId: 'cost_variance', value: '-250.00' }],
      passages: [],
      entities: [],
    };
    expect(validateGrounding('Variance was -250.00.', negativeBundle)).toEqual({ ok: true });
    // Dropping the sign changes the direction of the money — that is a different claim.
    expect(validateGrounding('Variance was 250.00.', negativeBundle).ok).toBe(false);
  });

  it('a hyphen joining a range does not turn the second bound negative', () => {
    const rangeBundle: GroundingBundle = {
      metrics: [
        { ...realMetric, metricId: 'a', value: '10' },
        { ...realMetric, metricId: 'b', value: '15' },
      ],
      passages: [],
      entities: [],
    };
    expect(validateGrounding('Between 10-15 units.', rangeBundle)).toEqual({ ok: true });
  });

  it('a number appearing VERBATIM in a retrieved passage is grounded — the reader can open the cited document and see it', () => {
    const withPassage: GroundingBundle = {
      metrics: [],
      passages: [{ sourceType: 'document_chunk', sourceId: 'doc-1', text: 'Flour 25kg @ 1,120.00 per bag', score: 0.9 }],
      entities: [],
    };
    expect(validateGrounding('The invoice lists flour at 1,120.00 per bag.', withPassage)).toEqual({ ok: true });
  });

  it('a passage number quoted in a DIFFERENT format is a violation — source figures get no formatting tolerance', () => {
    const withPassage: GroundingBundle = {
      metrics: [],
      passages: [{ sourceType: 'document_chunk', sourceId: 'doc-1', text: 'Flour 25kg @ 1,120.00 per bag', score: 0.9 }],
      entities: [],
    };
    // "about 1120" drops the decimals the source carries — normalize strips the comma on both
    // sides, so "1,120.00" matches "1120.00" but never a rounded "1120".
    expect(validateGrounding('Flour costs about 1120 per bag.', withPassage).ok).toBe(false);
  });

  it('a fabricated figure is still a violation even when passages are present — passages widen the allowlist only by their own tokens', () => {
    const withPassage: GroundingBundle = {
      metrics: [{ ...realMetric, value: '1000.00' }],
      passages: [{ sourceType: 'document_chunk', sourceId: 'doc-1', text: 'Flour 25kg @ 1,120.00 per bag', score: 0.9 }],
      entities: [],
    };
    const result = validateGrounding('Your margin was 4200 on flour bought at 1,120.00.', withPassage);
    expect(result).toEqual({ ok: false, violations: ['4200'] });
  });

  it('KNOWN residual gap: a figure written out as words is NOT caught — the boundary is digits', () => {
    // Deliberate: word-number extraction has a false-positive rate that would burn the single
    // regeneration on innocent prose. The guarantee this validator makes is that no DIGIT-shaped
    // fabrication survives; this test pins that boundary so a future change is a decision, not
    // an accident.
    const result = validateGrounding('You lost forty-two hundred rupees.', bundle);
    expect(result).toEqual({ ok: true });
  });
});
