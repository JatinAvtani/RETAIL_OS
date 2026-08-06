import { describe, expect, it } from 'vitest';
import { createCircuitBreakerExtractionProvider, type CircuitState } from './circuit-breaker-extraction-provider';
import type { ExtractionProvider, ExtractionResult } from './extraction-provider';

const okResult = (provider: string): ExtractionResult => ({ provider, modelVersion: 'v1', latencyMs: 1, error: null, fields: null, lines: null, overallConfidence: null });
const errorResult = (provider: string, error: string): ExtractionResult => ({ provider, modelVersion: 'v1', latencyMs: 1, error, fields: null, lines: null, overallConfidence: null });

const makeProvider = (name: string, behavior: (() => ExtractionResult)[]): ExtractionProvider & { callCount: () => number } => {
  let i = 0;
  const calls: number[] = [];
  return {
    name,
    async extract() {
      calls.push(1);
      const result = behavior[Math.min(i, behavior.length - 1)]!();
      i++;
      return result;
    },
    callCount: () => calls.length,
  };
};

const withGetState = (provider: ExtractionProvider) => provider as ExtractionProvider & { getState: () => CircuitState };

describe('createCircuitBreakerExtractionProvider', () => {
  it('routes to the primary while CLOSED, never touching the secondary on success', async () => {
    const primary = makeProvider('primary', [() => okResult('primary')]);
    const secondary = makeProvider('secondary', [() => okResult('secondary')]);
    const breaker = createCircuitBreakerExtractionProvider(primary, secondary, { failureThreshold: 3, resetTimeoutMs: 1000 });

    const result = await breaker.extract(Buffer.from(''), 'application/pdf');

    expect(result.provider).toBe('primary');
    expect(primary.callCount()).toBe(1);
    expect(secondary.callCount()).toBe(0);
    expect(withGetState(breaker).getState()).toBe('CLOSED');
  });

  it('falls back to the secondary on a single primary failure, without opening the circuit yet', async () => {
    const primary = makeProvider('primary', [() => errorResult('primary', 'transient error')]);
    const secondary = makeProvider('secondary', [() => okResult('secondary')]);
    const breaker = createCircuitBreakerExtractionProvider(primary, secondary, { failureThreshold: 3, resetTimeoutMs: 1000 });

    const result = await breaker.extract(Buffer.from(''), 'application/pdf');

    expect(result.provider).toBe('secondary');
    expect(withGetState(breaker).getState()).toBe('CLOSED');
  });

  it('opens the circuit after failureThreshold consecutive primary failures, routing straight to the secondary WITHOUT calling the primary again', async () => {
    const time = 0;
    const primary = makeProvider('primary', [() => errorResult('primary', 'down')]);
    const secondary = makeProvider('secondary', [() => okResult('secondary')]);
    const breaker = createCircuitBreakerExtractionProvider(primary, secondary, { failureThreshold: 2, resetTimeoutMs: 1000, now: () => time });

    await breaker.extract(Buffer.from(''), 'application/pdf');
    await breaker.extract(Buffer.from(''), 'application/pdf');
    expect(withGetState(breaker).getState()).toBe('OPEN');
    expect(primary.callCount()).toBe(2);

    // A third call, still within the reset timeout — the circuit must skip the primary entirely.
    await breaker.extract(Buffer.from(''), 'application/pdf');
    expect(primary.callCount()).toBe(2); // unchanged — the primary was never called this time.
    expect(secondary.callCount()).toBe(3);
  });

  it('moves to HALF_OPEN after resetTimeoutMs and tries the primary again exactly once', async () => {
    let time = 0;
    const primary = makeProvider('primary', [() => errorResult('primary', 'down'), () => okResult('primary')]);
    const secondary = makeProvider('secondary', [() => okResult('secondary')]);
    const breaker = createCircuitBreakerExtractionProvider(primary, secondary, { failureThreshold: 1, resetTimeoutMs: 1000, now: () => time });

    await breaker.extract(Buffer.from(''), 'application/pdf');
    expect(withGetState(breaker).getState()).toBe('OPEN');

    time += 1000; // advance past the reset timeout
    expect(withGetState(breaker).getState()).toBe('HALF_OPEN');

    const result = await breaker.extract(Buffer.from(''), 'application/pdf');
    expect(result.provider).toBe('primary'); // the HALF_OPEN trial call genuinely reached the primary.
    expect(withGetState(breaker).getState()).toBe('CLOSED'); // success closes the circuit.
  });

  it('a failed HALF_OPEN trial re-opens the circuit and restarts the timeout', async () => {
    let time = 0;
    const primary = makeProvider('primary', [() => errorResult('primary', 'still down'), () => errorResult('primary', 'still down')]);
    const secondary = makeProvider('secondary', [() => okResult('secondary')]);
    const breaker = createCircuitBreakerExtractionProvider(primary, secondary, { failureThreshold: 1, resetTimeoutMs: 1000, now: () => time });

    await breaker.extract(Buffer.from(''), 'application/pdf');
    time += 1000;
    expect(withGetState(breaker).getState()).toBe('HALF_OPEN');

    await breaker.extract(Buffer.from(''), 'application/pdf'); // the trial call fails again.
    expect(withGetState(breaker).getState()).toBe('OPEN');

    // Immediately after re-opening, still within the NEW timeout window — must stay OPEN.
    expect(withGetState(breaker).getState()).toBe('OPEN');
  });

  it('the provider name reflects both wrapped providers for operational visibility', () => {
    const primary = makeProvider('gemini', []);
    const secondary = makeProvider('tesseract', []);
    const breaker = createCircuitBreakerExtractionProvider(primary, secondary, { failureThreshold: 1, resetTimeoutMs: 1000 });

    expect(breaker.name).toBe('circuit-breaker(gemini->tesseract)');
  });
});
