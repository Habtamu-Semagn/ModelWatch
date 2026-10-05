import { GroqAdapter } from "./groq.ts";
import { GoogleAdapter } from "./google.ts";
import type { ModelAdapter } from "./types.ts";

export type { EvalRequest, EvalResponse, ModelAdapter } from "./types.ts";
export { AdapterError } from "./types.ts";

const groq = new GroqAdapter();
const google = new GoogleAdapter();

/**
 * Keyed by the EXACT model_version string. No fuzzy matching.
 *
 * NOTE (2026-10): the spec's original picks are both shut down —
 * Groq's qwen-2.5-coder-32b is off the model list, and Google's
 * gemini-2.0-flash was shut down 2026-06-01.
 *
 * Google's 3.x Flash models are THINKING models: every response also carries
 * thoughtsTokenCount on top of candidatesTokenCount, and maxOutputTokens must
 * cover BOTH. A 512-token budget is enough for a ~200-token patch's visible
 * answer but gets fully consumed by thinking, so the adapter raises the budget
 * (see google.ts) rather than letting the model return empty text.
 *
 *   primary  qwen/qwen3.8-27b     (Groq, ~450 t/s, 250K TPM / 1K RPM)
 *   baseline gemini-3.5-flash-lite (Google AI Studio; see note)
 *   judge    openai/gpt-oss-120b  (Groq — phase 2, OpenAI family, so it is
 *                                 cross-family against BOTH Gemini and Qwen)
 *
 * The spec's judge, llama-3.3-70b-versatile, is no longer served to this key
 * (404 "does not exist or you do not have access"). gpt-oss is the only family
 * left on the account that is neither Google nor Alibaba, which is what keeps
 * the cross-family rule intact. It is also a reasoning model, so its rubric
 * budget must cover reasoning tokens or the answer comes back empty — same
 * trap as Gemini, see google.ts.
 *
 * Why flash-LITE and not gemini-3.8-flash: the free tier is a DAILY budget and
 * it is per-MODEL, not per-project. gemini-3.8-flash's 20/day went to zero
 * mid-run and no amount of throttling brings it back same-day; the flash-lite
 * tier counts separately and still answered. Both are Google and both are
 * Gemini, so the cross-family rule (Qwen vs Gemini) still holds.
 */
const REGISTRY: Record<string, ModelAdapter> = {
  "qwen/qwen3.8-27b": groq,
  "openai/gpt-oss-120b": groq,
  "openai/gpt-oss-20b": groq,
  "gemini-3.8-flash": google,
  "gemini-3.5-flash-lite": google,
};

export const MODEL_VERSIONS = Object.keys(REGISTRY);

export function adapterFor(modelVersion: string): ModelAdapter {
  const a = REGISTRY[modelVersion];
  if (!a) throw new Error(`no adapter registered for model_version "${modelVersion}"`);
  return a;
}

export function providerFor(modelVersion: string): string {
  return adapterFor(modelVersion).provider;
}