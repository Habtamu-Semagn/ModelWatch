# Adding a provider later (OpenRouter, Cerebras, a local runtime)

An adapter is one file exporting a class implementing `ModelAdapter`:

```ts
import type { EvalRequest, EvalResponse, ModelAdapter } from "./types.ts";

export class MyAdapter implements ModelAdapter {
  readonly provider = "groq" as const; // widen the union in types.ts
  async complete(req: EvalRequest): Promise<EvalResponse> {
    // map req -> your provider's HTTP shape
    // return { provider, modelVersion: req.modelVersion, text,
    //          inputTokens, outputTokens }
  }
}
```

Rules that keep the rest of the system provider-agnostic:

1. Return ONLY model text. No scoring, no retries, no caching — `runUnit.ts`
   owns cache, limiter and scoring. The adapter is a pure HTTP shim.
2. Throw `AdapterError(provider, status, body)` on non-2xx. The worker decides
   whether to retry the unit.
3. Never rewrite `req.modelVersion`. It is the DB identity of the run.
4. Report real token usage; the limiter and run reports use these numbers.
5. Register in `index.ts` keyed by the exact model string. No fuzzy matching.

## Current registry

As of 2026-10. The spec's original picks are gone: Groq retired
`qwen-2.5-coder-32b` and Google shut down `gemini-2.0-flash` on 2026-06-01.

| model_version              | provider | adapter         | notes                    |
|----------------------------|----------|-----------------|--------------------------|
| `qwen/qwen3.8-27b`         | groq     | `GroqAdapter`   | primary, ~450 t/s        |
| `openai/gpt-oss-120b`     | groq     | `GroqAdapter`   | phase-2 judge (OpenAI family — cross-family vs both subjects) |
| `openai/gpt-oss-20b`      | groq     | `GroqAdapter`   | cheaper judge fallback                                |
| `gemini-3.8-flash`         | google   | `GoogleAdapter` | daily budget exhausted mid-run |
| `gemini-3.5-flash-lite`    | google   | `GoogleAdapter` | current baseline, free tier |

Adding a provider means: create the file, append its models to the registry in
`index.ts`, and (if rate-limited) insert a `provider_limits` row.