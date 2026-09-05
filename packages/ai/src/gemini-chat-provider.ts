import { GoogleGenAI } from '@google/genai';
import type { ChatProvider, ChatResult, StructuredChatResult } from './chat-provider';

/**
 * The Gemini implementation of `ChatProvider`. `model` is passed per call, not baked into
 * the provider at construction — the same client serves every task tier (`modelForTask`), matching
 * how one `GEMINI_API_KEY` already serves extraction/classification/embedding with no separate
 * client per capability.
 *
 * Same request-timeout discipline as `gemini-extraction-provider.ts`: an unbounded `await` on a
 * slow (not erroring) response would block any caller — the planning stage and the narration
 * stage both sit in front of a real user waiting for a response.
 */
/**
 * Deliberately kept at 15s even though the API can take 45-67s to return a `503 UNAVAILABLE` when a
 * model is overloaded (measured on `gemini-flash-latest`, 2026-08-24). Waiting for that real error
 * would give a more precise message, but it would also leave a user staring at a spinner for over a
 * minute — a worse outcome than a fast, honest "couldn't reach the model, try again".
 *
 * The trade-off has a real cost worth naming: an overloaded model surfaces as an opaque TIMEOUT
 * rather than "model unavailable", so the logs do not distinguish "Google is down" from "the
 * network is slow". The mitigation is model selection (see model-config.ts), not a longer wait.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Every call pins temperature to 0.
 *
 * Nothing set it before, so all three tasks ran at Gemini's default sampling and identical inputs
 * produced different answers run to run. That was visible in the golden eval: `injection-fabricate-
 * number` flipped PASS to FAIL between two runs with no code change to the classifier at all, which
 * makes the suite's score unreproducible and any comparison between runs meaningless.
 *
 * None of this assistant's model calls WANT variety. Classification picks one intent from a closed
 * set, planning picks metric ids and copies parameters, and narration is policed by a validator that
 * rejects any number not already in the bundle. Sampling buys nothing in any of the three and costs
 * reproducibility in all of them.
 */
const DETERMINISTIC_TEMPERATURE = 0;

/**
 * A `503 UNAVAILABLE` ("this model is currently experiencing high demand") is Google-side capacity,
 * not a fault in the request — the identical call typically succeeds moments later. Without a
 * retry, one transient spike failed a whole multi-hop investigation, which is a real, observed
 * outcome: `investigations` rows carrying exactly that 503 body sit alongside COMPLETE rows from
 * the same key, model and hour.
 *
 * Bounded deliberately at two extra attempts with a short fixed backoff. A user is waiting in front
 * of both the planning and narration calls, so the worst case stays under ~35s
 * (3 × 15s timeout is the true ceiling, but a 503 returns fast; only a genuine hang costs the full
 * timeout). Retrying more, or with a longer backoff, trades a bounded failure for an unbounded wait.
 */
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 700;

/**
 * Only genuinely transient, server-side conditions are retried — never a malformed request, a bad
 * schema, or an auth/quota rejection, all of which fail identically no matter how many times they
 * are sent. Retrying a real 429 would also actively worsen a quota exhaustion this project has hit
 * before, so it is excluded on purpose.
 */
const isTransient = (message: string): boolean =>
  /\b(503|500|502|504)\b/.test(message) || /UNAVAILABLE|INTERNAL|deadline|timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(message);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt` up to `MAX_ATTEMPTS` times, stopping at the first success or the first
 * NON-transient failure. `toError` reads the provider-shaped result (which reports failure in an
 * `error` field rather than by throwing), so both a thrown exception and a returned error are
 * covered by the same policy.
 */
const withRetry = async <T>(attempt: () => Promise<T>, toError: (result: T) => string | null): Promise<T> => {
  let last: T = await attempt();
  for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
    const error = toError(last);
    if (error === null || !isTransient(error)) return last;
    await sleep(RETRY_BACKOFF_MS * i);
    last = await attempt();
  }
  return last;
};

export const createGeminiChatProvider = (apiKey: string): ChatProvider => {
  const client = new GoogleGenAI({ apiKey });

  return {
    name: 'gemini',

    async generate(prompt: string, model: string): Promise<ChatResult> {
      return withRetry<ChatResult>(async () => {
        const started = Date.now();

        try {
          const response = await client.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: { temperature: DETERMINISTIC_TEMPERATURE, httpOptions: { timeout: REQUEST_TIMEOUT_MS } },
          });

          const latencyMs = Date.now() - started;
          const text = response.text;
          if (!text) {
            return { provider: 'gemini', modelVersion: model, latencyMs, error: 'empty response text', text: null };
          }

          return { provider: 'gemini', modelVersion: model, latencyMs, error: null, text };
        } catch (e) {
          return { provider: 'gemini', modelVersion: model, latencyMs: Date.now() - started, error: (e as Error).message, text: null };
        }
      }, (result) => result.error);
    },

    async generateStructured(prompt: string, model: string, schema: Record<string, unknown>): Promise<StructuredChatResult> {
      return withRetry<StructuredChatResult>(async () => {
        const started = Date.now();

        try {
          const response = await client.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
              temperature: DETERMINISTIC_TEMPERATURE,
              responseMimeType: 'application/json',
              responseSchema: schema,
              httpOptions: { timeout: REQUEST_TIMEOUT_MS },
            },
          });

          const latencyMs = Date.now() - started;
          const text = response.text;
          if (!text) {
            return { provider: 'gemini', modelVersion: model, latencyMs, error: 'empty response text', data: null };
          }

          try {
            const data = JSON.parse(text);
            return { provider: 'gemini', modelVersion: model, latencyMs, error: null, data };
          } catch (e) {
            return { provider: 'gemini', modelVersion: model, latencyMs, error: `malformed JSON: ${(e as Error).message}`, data: null };
          }
        } catch (e) {
          return { provider: 'gemini', modelVersion: model, latencyMs: Date.now() - started, error: (e as Error).message, data: null };
        }
      }, (result) => result.error);
    },
  };
};
