import { createHash } from "node:crypto";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export { pool };

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export interface CacheKeyParts {
  provider: string;
  modelVersion: string;
  system: string;
  prompt: string;
  paramsHash: string;
  sampleIdx: number;
  seed: number;
}

/**
 * Key = (provider, model_version, system_prompt_hash, prompt_hash,
 *        params_hash, sample_idx, seed). sample_idx MUST be in the key or
 * samples collide and you silently lose variance.
 */
export function cacheKey(p: CacheKeyParts): string {
  return sha(
    [
      p.provider,
      p.modelVersion,
      sha(p.system),
      sha(p.prompt),
      p.paramsHash,
      String(p.sampleIdx),
      String(p.seed),
    ].join("\u0000")
  );
}

export function paramsHash(params: Record<string, unknown>): string {
  return sha(JSON.stringify(params, Object.keys(params).sort()));
}

/** Column-shaped, so what cacheGet returns is exactly what cachePut takes. */
export interface CacheEntry {
  response: string;
  input_tokens: number;
  output_tokens: number;
}

export async function cacheGet(key: string): Promise<CacheEntry | null> {
  const { rows } = await pool.query<CacheEntry>(
    `SELECT response, input_tokens, output_tokens FROM cache WHERE cache_key = $1`,
    [key]
  );
  return rows[0] ?? null;
}

export async function cachePut(
  key: string,
  parts: CacheKeyParts,
  entry: CacheEntry
): Promise<void> {
  await pool.query(
    `INSERT INTO cache (cache_key, provider, model_version, system_prompt_hash,
                        prompt_hash, params_hash, sample_idx, seed,
                        response, input_tokens, output_tokens)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (cache_key) DO NOTHING`,
    [
      key,
      parts.provider,
      parts.modelVersion,
      sha(parts.system),
      sha(parts.prompt),
      parts.paramsHash,
      parts.sampleIdx,
      parts.seed,
      entry.response,
      entry.input_tokens,
      entry.output_tokens,
    ]
  );
}