/**
 * The first genuine text-generation provider abstraction in this package —
 * `document-classification.ts`/`gemini-extraction-provider.ts`/`embedding-provider.ts` are each a
 * single hardcoded Gemini call with no interface, since nothing before this needed a second
 * provider or a swappable model. Planning and narration both need "send this prompt, get text
 * back" with no provider-specific detail leaking past this boundary — matching
 * `ExtractionProvider`'s own established shape: a narrow interface, a
 * `never throw for a provider-side failure` contract (`error` set instead), so a caller degrades
 * (refusal path, I5) rather than crashing.
 *
 * Deliberately excludes tool/function-calling from this interface — the scope here is provider
 * abstraction + model config, not a planning stage's tool surface. Adding that shape now, before a
 * real caller exists to prove it out, would be exactly the kind of speculative abstraction this
 * project avoids; extend this interface when a real caller actually needs it.
 */
export interface ChatResult {
  provider: string;
  modelVersion: string;
  latencyMs: number;
  error: string | null;
  text: string | null;
}

/**
 * Extends the provider abstraction for schema-constrained JSON output — intent
 * classification needs a real, closed answer set, not free text a caller then has to parse and
 * hope matches one of five expected strings. `schema` is a plain JSON-Schema-shaped object, not
 * `@google/genai`'s own `Type`-enum format — that SDK-specific shape stays inside
 * `gemini-chat-provider.ts`, matching this package's "no provider SDK imported outside
 * packages/ai" rule; Gemini's own `responseSchema` already accepts a JSON-Schema-compatible
 * shape directly, so no translation layer is needed for the one provider that exists today. A
 * successful call's `data` is `unknown` — the caller (e.g. `classifyIntent`) is responsible for
 * validating the parsed JSON actually matches what it asked for, the same "never trust the model
 * past its own schema" discipline `document-classification.ts` already established.
 */
export interface StructuredChatResult {
  provider: string;
  modelVersion: string;
  latencyMs: number;
  error: string | null;
  data: unknown;
}

export interface ChatProvider {
  name: string;
  generate(prompt: string, model: string): Promise<ChatResult>;
  generateStructured(prompt: string, model: string, schema: Record<string, unknown>): Promise<StructuredChatResult>;
}
