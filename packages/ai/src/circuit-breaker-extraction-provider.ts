import type { ExtractionProvider, ExtractionResult } from './extraction-provider';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive primary failures before the circuit opens (routes to the secondary). */
  failureThreshold: number;
  /** How long the circuit stays OPEN before allowing one real trial call to the primary again (HALF_OPEN). */
  resetTimeoutMs: number;
  /** Injectable for tests — real code omits this and gets the real clock. */
  now?: () => number;
}

/**
 * 007-06 (plan.md Phase 2: "Primary + secondary configured. Circuit breaker; fall back on
 * outage."). A small, real, hand-written implementation rather than a library — the state machine
 * itself is genuinely simple (three states, two transitions), and this project's own general bias
 * is toward owning simple logic rather than adding a dependency for something this size (no
 * existing circuit-breaker library was already a dependency anywhere in this codebase).
 *
 * States:
 * - CLOSED: normal operation, every call goes to the primary. A failure increments a counter; N
 *   consecutive failures (`failureThreshold`) opens the circuit.
 * - OPEN: every call goes straight to the secondary, WITHOUT even trying the primary — this is the
 *   whole point of a circuit breaker over a plain retry-then-fallback: it stops hammering a known-
 *   down primary with real (rate-limited, costly-in-latency) calls. After `resetTimeoutMs`, the
 *   circuit moves to HALF_OPEN.
 * - HALF_OPEN: exactly one real trial call goes to the primary. Success closes the circuit
 *   (resuming normal operation); failure re-opens it and restarts the timeout.
 *
 * A provider's own `error` field (never a thrown exception, per `ExtractionProvider`'s contract) is
 * what the breaker treats as failure — this composes correctly with `GeminiExtractionProvider`'s
 * own "never throw" discipline without needing a separate exception-based failure signal.
 */
export const createCircuitBreakerExtractionProvider = (primary: ExtractionProvider, secondary: ExtractionProvider, options: CircuitBreakerOptions): ExtractionProvider => {
  const now = options.now ?? (() => Date.now());
  let state: CircuitState = 'CLOSED';
  let consecutiveFailures = 0;
  let openedAt: number | null = null;

  const recordSuccess = () => {
    consecutiveFailures = 0;
    state = 'CLOSED';
    openedAt = null;
  };

  const recordFailure = () => {
    consecutiveFailures += 1;
    if (state === 'HALF_OPEN' || consecutiveFailures >= options.failureThreshold) {
      state = 'OPEN';
      openedAt = now();
    }
  };

  const maybeTransitionToHalfOpen = () => {
    if (state === 'OPEN' && openedAt !== null && now() - openedAt >= options.resetTimeoutMs) {
      state = 'HALF_OPEN';
    }
  };

  return {
    name: `circuit-breaker(${primary.name}->${secondary.name})`,

    async extract(bytes: Buffer, mimeType: string): Promise<ExtractionResult> {
      maybeTransitionToHalfOpen();

      if (state === 'OPEN') {
        // Never touches the primary while genuinely open — the whole point of the pattern.
        return secondary.extract(bytes, mimeType);
      }

      const result = await primary.extract(bytes, mimeType);
      if (result.error) {
        recordFailure();
        return secondary.extract(bytes, mimeType);
      }
      recordSuccess();
      return result;
    },

    // Exposed for tests and operational visibility — not part of the ExtractionProvider contract,
    // an extension specific to this wrapper.
    getState: (): CircuitState => {
      maybeTransitionToHalfOpen();
      return state;
    },
  } as ExtractionProvider & { getState: () => CircuitState };
};
