import { describe, expect, it, vi } from 'vitest';
import type { ChatProvider, StructuredChatResult } from './chat-provider';
import { classifyIntent } from './intent-classification';

/**
 * 010-03: `classifyIntent`'s own contract, tested against a fake `ChatProvider` rather than
 * mocking `@google/genai` directly — the whole point of routing this through `ChatProvider`
 * (010-01) is that `classifyIntent` itself is provider-agnostic, so its test should be too.
 * Every failure mode must degrade to `{ intent: 'UNSUPPORTED', confidence: 0, error: <reason> }`,
 * never a guessed specific intent (the same I7-for-labels discipline `classifyDocument` already
 * established) — an unrecognized intent, not just an unrecognized document type, still routes to
 * entirely the wrong pipeline if guessed wrong.
 */
const fakeProvider = (result: StructuredChatResult): ChatProvider => ({
  name: 'fake',
  generate: vi.fn(),
  generateStructured: vi.fn().mockResolvedValue(result),
});

const ok = (data: unknown): StructuredChatResult => ({ provider: 'fake', modelVersion: 'fake-model', latencyMs: 1, error: null, data });
const failed = (error: string): StructuredChatResult => ({ provider: 'fake', modelVersion: 'fake-model', latencyMs: 1, error, data: null });

describe('classifyIntent', () => {
  it('returns the classified intent and confidence on a well-formed response', async () => {
    const provider = fakeProvider(ok({ intent: 'METRIC', confidence: 0.94 }));

    const result = await classifyIntent(provider, 'What is my food cost this month?', 'fake-model');

    expect(result).toEqual({ intent: 'METRIC', confidence: 0.94, error: null });
  });

  it('accepts every real intent value, not just METRIC', async () => {
    for (const intent of ['METRIC', 'RETRIEVAL', 'HYBRID', 'ACTION_DRAFT', 'UNSUPPORTED']) {
      const provider = fakeProvider(ok({ intent, confidence: 0.8 }));
      const result = await classifyIntent(provider, 'some question', 'fake-model');
      expect(result.intent).toBe(intent);
      expect(result.error).toBeNull();
    }
  });

  it('degrades to UNSUPPORTED when the provider itself reports an error', async () => {
    const provider = fakeProvider(failed('503 Service Unavailable'));

    const result = await classifyIntent(provider, 'What is my food cost?', 'fake-model');

    expect(result.intent).toBe('UNSUPPORTED');
    expect(result.confidence).toBe(0);
    expect(result.error).toBe('503 Service Unavailable');
  });

  it('degrades to UNSUPPORTED when the response shape has no intent field', async () => {
    const provider = fakeProvider(ok({ confidence: 0.8 }));

    const result = await classifyIntent(provider, 'question', 'fake-model');

    expect(result.intent).toBe('UNSUPPORTED');
    expect(result.confidence).toBe(0);
    expect(result.error).toContain('expected classification shape');
  });

  it('degrades to UNSUPPORTED when intent is not one of the five real values', async () => {
    const provider = fakeProvider(ok({ intent: 'SOMETHING_ELSE', confidence: 0.9 }));

    const result = await classifyIntent(provider, 'question', 'fake-model');

    expect(result.intent).toBe('UNSUPPORTED');
    expect(result.error).toContain('expected classification shape');
  });

  it('degrades to UNSUPPORTED when confidence is missing or not a number', async () => {
    const provider = fakeProvider(ok({ intent: 'METRIC' }));

    const result = await classifyIntent(provider, 'question', 'fake-model');

    expect(result.intent).toBe('UNSUPPORTED');
    expect(result.error).toContain('expected classification shape');
  });

  it('accepts a genuinely low-confidence UNSUPPORTED classification as a real result, not an error', async () => {
    const provider = fakeProvider(ok({ intent: 'UNSUPPORTED', confidence: 0.2 }));

    const result = await classifyIntent(provider, 'question', 'fake-model');

    expect(result).toEqual({ intent: 'UNSUPPORTED', confidence: 0.2, error: null });
  });

  it('passes the question through to the provider inside the prompt', async () => {
    const generateStructured = vi.fn().mockResolvedValue(ok({ intent: 'METRIC', confidence: 0.9 }));
    const provider: ChatProvider = { name: 'fake', generate: vi.fn(), generateStructured };

    await classifyIntent(provider, 'What is my food cost this month?', 'fake-model');

    expect(generateStructured).toHaveBeenCalledWith(expect.stringContaining('What is my food cost this month?'), 'fake-model', expect.any(Object));
  });
});
