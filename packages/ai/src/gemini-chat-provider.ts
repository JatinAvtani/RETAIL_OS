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

export const createGeminiChatProvider = (apiKey: string): ChatProvider => {
  const client = new GoogleGenAI({ apiKey });

  return {
    name: 'gemini',

    async generate(prompt: string, model: string): Promise<ChatResult> {
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
    },

    async generateStructured(prompt: string, model: string, schema: Record<string, unknown>): Promise<StructuredChatResult> {
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
    },
  };
};
