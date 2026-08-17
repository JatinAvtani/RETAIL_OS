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
const REQUEST_TIMEOUT_MS = 15_000;

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
          config: { httpOptions: { timeout: REQUEST_TIMEOUT_MS } },
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
