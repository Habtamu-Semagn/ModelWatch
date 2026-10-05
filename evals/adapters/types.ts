/** Shared adapter contract. Every provider implements exactly this. */
export interface EvalRequest {
  /** model_version: the exact string, e.g. "qwen-2.5-coder-32b" */
  modelVersion: string;
  system: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
  seed: number;
}

export interface EvalResponse {
  provider: string;
  modelVersion: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelAdapter {
  readonly provider: "groq" | "google";
  complete(req: EvalRequest): Promise<EvalResponse>;
}

export class AdapterError extends Error {
  constructor(
    public provider: string,
    public status: number,
    public body: string,
    /** Parsed Retry-After header, seconds. Lets the worker back off correctly. */
    public retryAfterSeconds?: number
  ) {
    super(`${provider} adapter HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = "AdapterError";
  }
}

/** Pull the message text out of a provider payload; providers differ, adapters do not. */
export function extractText(choiceText: string | undefined): string {
  return (choiceText ?? "").trim();
}

/** Retry-After is either delta-seconds or an HTTP date; we only honour seconds. */
export function parseRetryAfter(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const n = Number(h);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}