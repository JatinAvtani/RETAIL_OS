import { describe, expect, it, vi } from 'vitest';
import type { ChatProvider, ChatResult, StructuredChatResult } from '@retailos/ai';
import type { AuthContext } from '@retailos/authz';
import { runInvestigation } from './investigate';

/**
 * Same fake-provider convention `pipeline.test.ts` established: a queue of canned
 * `generateStructured`/`generate` responses driving the real `runPipeline`/`narrateAndValidate`/
 * `runInvestigation` functions with no live model or database. `ctx.db` stays `{}` — every test
 * uses `selections: []` so `executeSelections` never reaches a real metric, matching
 * `pipeline.test.ts`'s own reasoning for why that's still a faithful test of routing logic, not a
 * gap in coverage.
 */
const auth: AuthContext = {
  userId: 'user-1',
  organizationId: 'org-1',
  storeIds: 'ALL',
  role: 'OWNER',
  permissions: new Set(['financial:read']) as AuthContext['permissions'],
};
const ctx = { db: {} as never, organizationId: 'org-1', storeIds: 'ALL' as const };
const stores = [{ id: '11111111-1111-4111-8111-111111111111', name: 'Koramangala' }];

const okStructured = (data: unknown): StructuredChatResult => ({ provider: 'fake', modelVersion: 'fake-model', latencyMs: 1, error: null, data });
const okText = (text: string): ChatResult => ({ provider: 'fake', modelVersion: 'fake-model', latencyMs: 1, error: null, text });

/** `generateStructured` is called for: classify, plan (METRIC/HYBRID only), and this loop's own
 * sufficiency check — in that order, once per hop. `generate` is called once per hop for narration. */
const fakeProvider = (structuredQueue: StructuredChatResult[], textQueue: ChatResult[]): ChatProvider => {
  const generateStructured = vi.fn();
  for (const r of structuredQueue) generateStructured.mockResolvedValueOnce(r);
  const generate = vi.fn();
  for (const r of textQueue) generate.mockResolvedValueOnce(r);
  return { name: 'fake', generate, generateStructured };
};

describe('runInvestigation', () => {
  it('a single sufficient hop stops after hop 1 — never calls the model again once SUFFICIENT', async () => {
    const provider = fakeProvider(
      [
        okStructured({ intent: 'METRIC', confidence: 0.9 }), // classify (hop 1)
        okStructured({ selections: [] }), // plan (hop 1)
        okStructured({ decision: 'SUFFICIENT' }), // sufficiency check
      ],
      [okText('Revenue was flat this month.')] // narrate (hop 1)
    );

    const outcome = await runInvestigation(
      'What was my revenue this month?',
      provider,
      'classify-model',
      'plan-model',
      'narrate-model',
      auth,
      ctx,
      stores
    );

    expect(outcome.kind).toBe('investigation');
    if (outcome.kind !== 'investigation') return;
    expect(outcome.steps).toHaveLength(1);
    expect(outcome.steps[0]?.sufficiency).toBe('SUFFICIENT');
    expect(outcome.steps[0]?.narration).toBe('Revenue was flat this month.');
    expect(provider.generateStructured).toHaveBeenCalledTimes(3);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it('NEEDS_FOLLOWUP chains a real second hop using the model\'s own follow-up question', async () => {
    const provider = fakeProvider(
      [
        okStructured({ intent: 'METRIC', confidence: 0.9 }), // classify (hop 1)
        okStructured({ selections: [] }), // plan (hop 1)
        okStructured({ decision: 'NEEDS_FOLLOWUP', followUpQuestion: 'which item drove the change' }), // sufficiency after hop 1
        okStructured({ intent: 'METRIC', confidence: 0.9 }), // classify (hop 2)
        okStructured({ selections: [] }), // plan (hop 2)
        okStructured({ decision: 'SUFFICIENT' }), // sufficiency after hop 2
      ],
      [okText('Margin dropped significantly in June.'), okText('Cheese Burst Pizza drove the drop.')]
    );

    const outcome = await runInvestigation(
      'Why did margin drop in June?',
      provider,
      'classify-model',
      'plan-model',
      'narrate-model',
      auth,
      ctx,
      stores
    );

    expect(outcome.kind).toBe('investigation');
    if (outcome.kind !== 'investigation') return;
    expect(outcome.steps).toHaveLength(2);
    expect(outcome.steps[0]?.question).toBe('Why did margin drop in June?');
    expect(outcome.steps[1]?.question).toBe('which item drove the change');
    expect(outcome.steps[1]?.sufficiency).toBe('SUFFICIENT');
  });

  it('hits the hop limit and stops — never loops unboundedly even if the model keeps saying NEEDS_FOLLOWUP', async () => {
    const structuredQueue: StructuredChatResult[] = [];
    const textQueue: ChatResult[] = [];
    for (let i = 0; i < 3; i++) {
      structuredQueue.push(okStructured({ intent: 'METRIC', confidence: 0.9 }));
      structuredQueue.push(okStructured({ selections: [] }));
      if (i < 2) structuredQueue.push(okStructured({ decision: 'NEEDS_FOLLOWUP', followUpQuestion: `follow-up ${i}` }));
      textQueue.push(okText(`Answer text with no digits for this hop, attempt ${['first', 'second', 'third'][i]}.`));
    }

    const provider = fakeProvider(structuredQueue, textQueue);

    const outcome = await runInvestigation(
      'Why did margin drop?',
      provider,
      'classify-model',
      'plan-model',
      'narrate-model',
      auth,
      ctx,
      stores,
      [],
      [],
      3
    );

    expect(outcome.kind).toBe('investigation');
    if (outcome.kind !== 'investigation') return;
    expect(outcome.steps).toHaveLength(3);
    expect(outcome.steps[2]?.sufficiency).toBe('HOP_LIMIT_REACHED');
    // Exactly 3 hops of classify+plan (6) + 2 sufficiency checks (one after hop1, one after hop2,
    // none after hop3 since the loop stops for the hop-limit reason instead) = 8.
    expect(provider.generateStructured).toHaveBeenCalledTimes(8);
    expect(provider.generate).toHaveBeenCalledTimes(3);
  });

  it('a grounding failure on a hop stops the loop immediately — never feeds unvalidated text into the next plan', async () => {
    const provider = fakeProvider(
      [
        okStructured({ intent: 'METRIC', confidence: 0.9 }), // classify (hop 1)
        okStructured({ selections: [] }), // plan (hop 1)
      ],
      [
        okText('Revenue was exactly $47,382,991 which is definitely not grounded.'), // first narrate attempt
        okText('Still $47,382,991, still not grounded.'), // strict retry
      ]
    );

    const outcome = await runInvestigation(
      'What was my revenue?',
      provider,
      'classify-model',
      'plan-model',
      'narrate-model',
      auth,
      ctx,
      stores
    );

    expect(outcome.kind).toBe('investigation');
    if (outcome.kind !== 'investigation') return;
    expect(outcome.steps).toHaveLength(1);
    expect(outcome.steps[0]?.sufficiency).toBe('GROUNDING_FAILED');
    expect(outcome.steps[0]?.narration).toBeNull();
    // No sufficiency check should ever have been called — the loop stops BEFORE asking the model
    // whether to continue, since continuing would mean planning a follow-up from ungrounded text.
    expect(provider.generateStructured).toHaveBeenCalledTimes(2);
  });

  it('an ACTION_DRAFT outcome on hop 1, with real candidates supplied, passes straight through as a real draft', async () => {
    const provider = fakeProvider(
      [
        okStructured({ intent: 'ACTION_DRAFT', confidence: 0.9 }), // classify (hop 1)
        okStructured({ lines: [{ candidateId: 'c1', quantity: 5, unitLabel: 'bags' }] }), // planActionDraft
      ],
      []
    );

    const candidates = [{ candidateId: 'c1', label: 'Flour (25kg)' }];
    const outcome = await runInvestigation(
      'Order more flour',
      provider,
      'classify-model',
      'plan-model',
      'narrate-model',
      auth,
      ctx,
      stores,
      [],
      candidates
    );

    expect(outcome.kind).toBe('draft');
    if (outcome.kind !== 'draft') return;
    expect(outcome.draft.lines).toHaveLength(1);
    expect(outcome.draft.lines[0]?.candidateId).toBe('c1');
  });

  it('an ACTION_DRAFT question with NO candidates supplied returns the honest unsupported outcome, matching runPipeline', async () => {
    const provider = fakeProvider([okStructured({ intent: 'ACTION_DRAFT', confidence: 0.9 })], []);

    const outcome = await runInvestigation(
      'Order more flour',
      provider,
      'classify-model',
      'plan-model',
      'narrate-model',
      auth,
      ctx,
      stores
    );

    expect(outcome.kind).toBe('unsupported');
  });

  it('an UNSUPPORTED classification on hop 1 returns the honest refusal, no investigation attempted', async () => {
    const provider = fakeProvider([okStructured({ intent: 'UNSUPPORTED', confidence: 0.9 })], []);

    const outcome = await runInvestigation(
      'What will my sales be next quarter?',
      provider,
      'classify-model',
      'plan-model',
      'narrate-model',
      auth,
      ctx,
      stores
    );

    expect(outcome.kind).toBe('unsupported');
    if (outcome.kind !== 'unsupported') return;
    expect(outcome.reason).toContain('outside what this assistant');
  });
});
