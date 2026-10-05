import type { EvalRequest, EvalResponse, ModelAdapter } from "./types.ts";
import { AdapterError, extractText, parseRetryAfter } from "./types.ts";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Gemini 3.x Flash reasons before answering, and those thought tokens are
 * billed against maxOutputTokens. Measured on this dataset: a 19-token answer
 * cost ~165 thought tokens. 6x leaves headroom for hard tasks without letting
 * a runaway monologue eat the run's wall-clock.
 */
const THINKING_MULTIPLIER = 6;

export class GoogleAdapter implements ModelAdapter {
  readonly provider = "google" as const;

  constructor(private apiKey?: string) {}

  async complete(req: EvalRequest): Promise<EvalResponse> {
    const apiKey = this.apiKey ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_API_KEY is not set");
    const url = `${BASE}/${req.modelVersion}:generateContent?key=${apiKey}`;
    // 3.x Flash are thinking models: maxOutputTokens covers thinking tokens too,
    // so a budget sized for the visible answer alone returns empty text.
    // Multiply rather than drop the thinking, since reasoning is the point.
    const maxOutputTokens = req.maxTokens * THINKING_MULTIPLIER;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${req.system}\n\n${req.prompt}` }] }],
        generationConfig: {
          temperature: req.temperature,
          maxOutputTokens,
          seed: req.seed,
        },
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new AdapterError(this.provider, res.status, body, parseRetryAfter(res));
    const json = JSON.parse(body);
    const usage = json.usageMetadata ?? {};
    const text = extractText(json.candidates?.[0]?.content?.parts?.[0]?.text);
    if (!text) {
      // Empty with finishReason MAX_TOKENS means thinking ate the whole budget.
      throw new AdapterError(
        this.provider,
        200,
        `empty response (finishReason=${json.candidates?.[0]?.finishReason}, ` +
          `thoughts=${usage.thoughtsTokenCount}, candidates=${usage.candidatesTokenCount})`
      );
    }
    return {
      provider: this.provider,
      modelVersion: req.modelVersion,
      text,
      inputTokens: usage.promptTokenCount ?? 0,
      // Thinking tokens are real spend; report both so per-run cost is honest.
      outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    };
  }
}