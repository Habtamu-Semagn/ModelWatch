import type { EvalRequest, EvalResponse, ModelAdapter } from "./types.ts";
import { AdapterError, extractText, parseRetryAfter } from "./types.ts";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

export class GroqAdapter implements ModelAdapter {
  readonly provider = "groq" as const;

  /** Optional override; otherwise env is read at call time (not construction). */
  constructor(private apiKey?: string) {}

  /** Resolved at call time, not construction: env may be set after import. */
  async complete(req: EvalRequest): Promise<EvalResponse> {
    const apiKey = this.apiKey ?? process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is not set");
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: req.modelVersion,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.prompt },
        ],
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        seed: req.seed,
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new AdapterError(this.provider, res.status, body, parseRetryAfter(res));
    const json = JSON.parse(body);
    const usage = json.usage ?? {};
    return {
      provider: this.provider,
      modelVersion: req.modelVersion,
      text: extractText(json.choices?.[0]?.message?.content),
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
    };
  }
}