import { describe, expect, it, vi } from 'vitest';
import type { ChatProvider, StructuredChatResult } from '@retailos/ai';
import type { AuthContext } from '@retailos/authz';
import { runPipeline } from './pipeline';

/**
 * 010-09: `runPipeline`'s own contract — a fake `ChatProvider` that returns different structured
 * responses per call lets these tests drive classify→plan→execute through the real functions
 * without a live model. Real Postgres is not needed here either: every test uses `[]` selections
 * (a genuinely valid plan proposing nothing) so `executeSelections` never calls `executeMetric`
 * at all — the pipeline's OWN routing/assembly logic is what's under test, not metric execution
 * itself (already covered by `execute-selections.test.ts`) or planning validation (already
 * covered by `planning.test.ts`).
 */
const auth: AuthContext = {
  userId: 'user-1',
  organizationId: 'org-1',
  storeIds: 'ALL',
  role: 'OWNER',
  permissions: new Set(['financial:read']) as AuthContext['permissions'],
};
const ctx = { db: {} as never, organizationId: 'org-1', storeIds: 'ALL' as const };

const sequencedProvider = (responses: StructuredChatResult[]): ChatProvider => {
  const generateStructured = vi.fn();
  for (const r of responses) generateStructured.mockResolvedValueOnce(r);
  return { name: 'fake', generate: vi.fn(), generateStructured };
};

const ok = (data: unknown): StructuredChatResult => ({ provider: 'fake', modelVersion: 'fake-model', latencyMs: 1, error: null, data });
const failed = (error: string): StructuredChatResult => ({ provider: 'fake', modelVersion: 'fake-model', latencyMs: 1, error, data: null });

describe('runPipeline', () => {
  it('a METRIC-intent question with zero selections produces a real, valid empty-metrics bundle', async () => {
    const provider = sequencedProvider([
      ok({ intent: 'METRIC', confidence: 0.9 }), // classify
      ok({ selections: [] }), // plan
    ]);

    const outcome = await runPipeline('What is my net revenue?', provider, 'classify-model', 'plan-model', auth, ctx);

    expect(outcome).toEqual({
      kind: 'bundle',
      intent: 'METRIC',
      bundle: { metrics: [], passages: [], entities: [] },
      denied: [],
      failed: [],
      rejected: [],
    });
  });

  it('a RETRIEVAL-intent question returns unsupported, never a fabricated empty bundle — retrieval is not built yet', async () => {
    const provider = sequencedProvider([ok({ intent: 'RETRIEVAL', confidence: 0.9 })]);

    const outcome = await runPipeline('Find the contract with Nova Foods', provider, 'classify-model', 'plan-model', auth, ctx);

    expect(outcome.kind).toBe('unsupported');
    if (outcome.kind === 'unsupported') {
      expect(outcome.intent).toBe('RETRIEVAL');
      expect(outcome.reason).toContain('not built yet');
    }
  });

  it('a HYBRID-intent question also returns unsupported — half the answer (retrieval) does not exist yet', async () => {
    const provider = sequencedProvider([ok({ intent: 'HYBRID', confidence: 0.9 })]);

    const outcome = await runPipeline('Why did my food cost go up, check supplier notes', provider, 'classify-model', 'plan-model', auth, ctx);

    expect(outcome.kind).toBe('unsupported');
    if (outcome.kind === 'unsupported') expect(outcome.intent).toBe('HYBRID');
  });

  it('an ACTION_DRAFT-intent question returns unsupported — draft actions are not built yet (010-14)', async () => {
    const provider = sequencedProvider([ok({ intent: 'ACTION_DRAFT', confidence: 0.9 })]);

    const outcome = await runPipeline('Order more flour', provider, 'classify-model', 'plan-model', auth, ctx);

    expect(outcome.kind).toBe('unsupported');
    if (outcome.kind === 'unsupported') expect(outcome.intent).toBe('ACTION_DRAFT');
  });

  it('an UNSUPPORTED-intent question returns unsupported with a real reason, never a forced answer', async () => {
    const provider = sequencedProvider([ok({ intent: 'UNSUPPORTED', confidence: 0.9 })]);

    const outcome = await runPipeline('What is the capital of France?', provider, 'classify-model', 'plan-model', auth, ctx);

    expect(outcome.kind).toBe('unsupported');
    if (outcome.kind === 'unsupported') expect(outcome.intent).toBe('UNSUPPORTED');
  });

  it('degrades to a real error when classification itself fails, never silently treating it as METRIC', async () => {
    const provider = sequencedProvider([failed('503 Service Unavailable')]);

    const outcome = await runPipeline('question', provider, 'classify-model', 'plan-model', auth, ctx);

    expect(outcome).toEqual({ kind: 'error', reason: '503 Service Unavailable' });
  });

  it('degrades to a real error when planning fails, never silently returning an empty bundle for a METRIC question', async () => {
    const provider = sequencedProvider([ok({ intent: 'METRIC', confidence: 0.9 }), failed('504 Deadline Exceeded')]);

    const outcome = await runPipeline('What is my net revenue?', provider, 'classify-model', 'plan-model', auth, ctx);

    expect(outcome).toEqual({ kind: 'error', reason: '504 Deadline Exceeded' });
  });

  it('a rejected planning selection (invalid metricId/params) surfaces in the bundle outcome, never silently dropped', async () => {
    const provider = sequencedProvider([
      ok({ intent: 'METRIC', confidence: 0.9 }),
      ok({ selections: [{ metricId: 'invented_metric', paramsJson: '{}' }] }),
    ]);

    const outcome = await runPipeline('question', provider, 'classify-model', 'plan-model', auth, ctx);

    expect(outcome.kind).toBe('bundle');
    if (outcome.kind === 'bundle') {
      expect(outcome.bundle.metrics).toEqual([]);
      expect(outcome.rejected).toHaveLength(1);
      expect(outcome.rejected[0]?.metricId).toBe('invented_metric');
    }
  });

  it('passes the correct model to each stage — classifyModel for classification, planModel for planning', async () => {
    const generateStructured = vi
      .fn()
      .mockResolvedValueOnce(ok({ intent: 'METRIC', confidence: 0.9 }))
      .mockResolvedValueOnce(ok({ selections: [] }));
    const provider: ChatProvider = { name: 'fake', generate: vi.fn(), generateStructured };

    await runPipeline('question', provider, 'CLASSIFY_MODEL', 'PLAN_MODEL', auth, ctx);

    expect(generateStructured).toHaveBeenNthCalledWith(1, expect.any(String), 'CLASSIFY_MODEL', expect.any(Object));
    expect(generateStructured).toHaveBeenNthCalledWith(2, expect.any(String), 'PLAN_MODEL', expect.any(Object));
  });
});
