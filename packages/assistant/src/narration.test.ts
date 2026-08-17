import { describe, expect, it, vi } from 'vitest';
import type { ChatProvider, ChatResult } from '@retailos/ai';
import { narrate } from './narration';
import type { GroundingBundle } from './grounding-bundle';

/**
 * 010-10: `narrate`'s own contract, tested against a fake `ChatProvider` — same reasoning as
 * every other assistant-layer test in this package. `narrate` itself does no validation of the
 * model's response (010-11, not built) — these tests prove the PROMPT is built honestly (never
 * leaks raw data, always includes real values only) and that the function's own I/O contract
 * (never throw, degrade to a real error) holds, not that a live model's prose is "correct."
 */
const fakeProvider = (result: ChatResult): ChatProvider => ({
  name: 'fake',
  generate: vi.fn().mockResolvedValue(result),
  generateStructured: vi.fn(),
});

const ok = (text: string): ChatResult => ({ provider: 'fake', modelVersion: 'fake-model', latencyMs: 1, error: null, text });
const failed = (error: string): ChatResult => ({ provider: 'fake', modelVersion: 'fake-model', latencyMs: 1, error, text: null });

const realMetric: GroundingBundle['metrics'][number] = {
  metricId: 'net_revenue',
  value: '1234.5600',
  unit: 'CURRENCY',
  period: { from: new Date('2026-08-01'), to: new Date('2026-08-31') },
  computedAt: new Date('2026-08-31T23:59:00Z'),
  freshness: new Date('2026-08-31T23:59:00Z'),
  provenance: [{ table: 'sales_transaction_lines', rowCount: 12 }],
};

describe('narrate', () => {
  it('returns the real generated text on success', async () => {
    const provider = fakeProvider(ok('Your net revenue for August was $1,234.56.'));
    const bundle: GroundingBundle = { metrics: [realMetric], passages: [], entities: [] };

    const result = await narrate(provider, bundle, [], [], [], 'fake-model');

    expect(result.error).toBeNull();
    expect(result.text).toBe('Your net revenue for August was $1,234.56.');
  });

  it('the prompt includes the real metric value, not a fabricated one — checked directly, not assumed', async () => {
    const generate = vi.fn().mockResolvedValue(ok('answer'));
    const provider: ChatProvider = { name: 'fake', generate, generateStructured: vi.fn() };
    const bundle: GroundingBundle = { metrics: [realMetric], passages: [], entities: [] };

    await narrate(provider, bundle, [], [], [], 'fake-model');

    const [prompt] = generate.mock.calls[0] as [string, string];
    expect(prompt).toContain('net_revenue');
    expect(prompt).toContain('1234.5600');
  });

  it('a CURRENCY-unit metric never gets a fabricated currency symbol — no currency code exists on MetricResult to invent one from', async () => {
    const generate = vi.fn().mockResolvedValue(ok('answer'));
    const provider: ChatProvider = { name: 'fake', generate, generateStructured: vi.fn() };
    const bundle: GroundingBundle = { metrics: [realMetric], passages: [], entities: [] };

    await narrate(provider, bundle, [], [], [], 'fake-model');

    const [prompt] = generate.mock.calls[0] as [string, string];
    expect(prompt).not.toMatch(/[$€£¥]/);
    expect(prompt).toContain('currency unit not tracked');
  });

  it('a PERCENTAGE-unit metric gets a real % suffix in the prompt', async () => {
    const generate = vi.fn().mockResolvedValue(ok('answer'));
    const provider: ChatProvider = { name: 'fake', generate, generateStructured: vi.fn() };
    const pctMetric: GroundingBundle['metrics'][number] = { ...realMetric, metricId: 'food_cost_percentage', value: '28.4000', unit: 'PERCENTAGE' };
    const bundle: GroundingBundle = { metrics: [pctMetric], passages: [], entities: [] };

    await narrate(provider, bundle, [], [], [], 'fake-model');

    const [prompt] = generate.mock.calls[0] as [string, string];
    expect(prompt).toContain('28.4000%');
  });

  it('the prompt instructs the model to use ONLY the supplied values — never invent or derive', async () => {
    const generate = vi.fn().mockResolvedValue(ok('answer'));
    const provider: ChatProvider = { name: 'fake', generate, generateStructured: vi.fn() };
    const bundle: GroundingBundle = { metrics: [realMetric], passages: [], entities: [] };

    await narrate(provider, bundle, [], [], [], 'fake-model');

    const [prompt] = generate.mock.calls[0] as [string, string];
    expect(prompt.toLowerCase()).toContain('never calculate');
  });

  it('an unknown-valued metric is presented honestly as unknown, with its real reason — never a fabricated number', async () => {
    const generate = vi.fn().mockResolvedValue(ok('answer'));
    const provider: ChatProvider = { name: 'fake', generate, generateStructured: vi.fn() };
    const unknownMetric: GroundingBundle['metrics'][number] = {
      metricId: 'margin_per_item',
      value: 'unknown',
      unit: 'CURRENCY',
      period: { from: new Date('2026-08-01'), to: new Date('2026-08-31') },
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [],
      unknownReason: 'No recipe exists for this menu item.',
    };
    const bundle: GroundingBundle = { metrics: [unknownMetric], passages: [], entities: [] };

    await narrate(provider, bundle, [], [], [], 'fake-model');

    const [prompt] = generate.mock.calls[0] as [string, string];
    expect(prompt).toContain('margin_per_item');
    expect(prompt).toContain('unknown');
    expect(prompt).toContain('No recipe exists for this menu item.');
  });

  it('an empty bundle still produces a real prompt instructing an honest "insufficient" answer, not a silent no-op', async () => {
    const generate = vi.fn().mockResolvedValue(ok("I don't have enough information to answer that."));
    const provider: ChatProvider = { name: 'fake', generate, generateStructured: vi.fn() };
    const bundle: GroundingBundle = { metrics: [], passages: [], entities: [] };

    const result = await narrate(provider, bundle, [], [], [], 'fake-model');

    expect(result.error).toBeNull();
    const [prompt] = generate.mock.calls[0] as [string, string];
    expect(prompt.toLowerCase()).toContain('none');
  });

  it('a denied selection is surfaced in the prompt by name and reason, so the model can explain the gap honestly', async () => {
    const generate = vi.fn().mockResolvedValue(ok('answer'));
    const provider: ChatProvider = { name: 'fake', generate, generateStructured: vi.fn() };
    const bundle: GroundingBundle = { metrics: [], passages: [], entities: [] };

    await narrate(provider, bundle, [{ metricId: 'cogs_actual', reason: "Caller lacks 'financial:read'." }], [], [], 'fake-model');

    const [prompt] = generate.mock.calls[0] as [string, string];
    expect(prompt).toContain('cogs_actual');
    expect(prompt).toContain("Caller lacks 'financial:read'.");
  });

  it('a rejected planning selection is surfaced too, distinctly from a denied or failed one', async () => {
    const generate = vi.fn().mockResolvedValue(ok('answer'));
    const provider: ChatProvider = { name: 'fake', generate, generateStructured: vi.fn() };
    const bundle: GroundingBundle = { metrics: [], passages: [], entities: [] };

    await narrate(provider, bundle, [], [], [{ metricId: 'invented_metric', reason: "'invented_metric' is not a registered metric." }], 'fake-model');

    const [prompt] = generate.mock.calls[0] as [string, string];
    expect(prompt).toContain('invented_metric');
    expect(prompt).toContain('not a registered metric');
  });

  it('degrades to a real error when the provider itself fails, never a fabricated success', async () => {
    const provider = fakeProvider(failed('503 Service Unavailable'));
    const bundle: GroundingBundle = { metrics: [realMetric], passages: [], entities: [] };

    const result = await narrate(provider, bundle, [], [], [], 'fake-model');

    expect(result.error).toBe('503 Service Unavailable');
    expect(result.text).toBeNull();
  });
});
