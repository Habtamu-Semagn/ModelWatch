/**
 * Postgres token bucket, one row per provider. Free tiers hard-rate-limit, so
 * this is required, not optional.
 *
 *   UPDATE provider_limits
 *      SET tokens = LEAST(capacity, tokens + EXTRACT(EPOCH FROM now() - updated_at)
 *                          * refill_per_sec) - $cost,
 *          updated_at = now()
 *    WHERE provider = $1
 *      AND LEAST(capacity, tokens + EXTRACT(EPOCH FROM now() - updated_at)
 *              * refill_per_sec) >= $cost
 *    RETURNING tokens;
 *
 * Zero rows returned = not enough tokens: wait and retry. The whole thing is
 * one atomic statement, so N concurrent workers can't oversubscribe a provider.
 */
import { pool } from "./cache.ts";

export interface LimitConfig {
  provider: string;
  /** burst size = tokens available at full bucket */
  capacity: number;
  /** sustained rate, tokens per second */
  refillPerSec: number;
}

/**
 * Conservative starts, per spec. Trim once you observe real 429s.
 *
 * MEASURED (2026-10) against real keys, not guessed:
 *   groq   30/min sustained is fine — but max_tokens must stay under Groq's
 *          per-request OTPM ceiling (see run-eval.ts), which is a DIFFERENT
 *          limit and rejects regardless of bucket state.
 *   google the free tier is a DAILY budget, not a per-minute one. The 429 body
 *          says "generate_content_free_tier_requests, limit: 20" — 20/day at
 *          this key's tier. So the bucket is deliberately tiny: a per-minute
 *          limiter alone cannot protect a daily quota, and burning the budget
 *          in the first minute of a run starves every unit after it.
 */
export const DEFAULT_LIMITS: LimitConfig[] = [
  { provider: "groq", capacity: 30, refillPerSec: 30 / 60 },   // 30 req/min
  { provider: "google", capacity: 3, refillPerSec: 20 / 86400 }, // ~20/day
];

export async function seedLimits(limits: LimitConfig[] = DEFAULT_LIMITS): Promise<void> {
  for (const l of limits) {
    await pool.query(
      `INSERT INTO provider_limits (provider, capacity, refill_per_sec, tokens)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (provider) DO NOTHING`,
      [l.provider, l.capacity, l.refillPerSec, l.capacity]
    );
  }
}

export interface AcquireOptions {
  cost?: number;
  timeoutMs?: number;
  pollMs?: number;
  onWait?: (waitedMs: number) => void;
}

/**
 * Block until `cost` tokens are available for `provider`, then consume them.
 * Throws on timeout rather than proceeding — proceeding anyway is exactly how
 * you get a 429 storm.
 */
export async function acquire(
  provider: string,
  opts: AcquireOptions = {}
): Promise<number> {
  const cost = opts.cost ?? 1;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 250;
  const started = Date.now();

  for (;;) {
    const { rows } = await pool.query<{ tokens: string }>(
      `UPDATE provider_limits
          SET tokens = LEAST(capacity, tokens + EXTRACT(EPOCH FROM now() - updated_at)
                              * refill_per_sec) - $2,
              updated_at = now()
        WHERE provider = $1
          AND LEAST(capacity, tokens + EXTRACT(EPOCH FROM now() - updated_at)
                  * refill_per_sec) >= $2
      RETURNING tokens`,
      [provider, cost]
    );

    if (rows.length === 1) return Number(rows[0]!.tokens);

    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `limiter: no tokens for "${provider}" after ${timeoutMs}ms (cost=${cost})`
      );
    }
    opts.onWait?.(Date.now() - started);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Refill without spending — useful for tests and diagnostics. */
export async function peek(provider: string): Promise<{
  tokens: number;
  capacity: number;
  refillPerSec: number;
} | null> {
  const { rows } = await pool.query<{ tokens: string; capacity: string; refill_per_sec: string }>(
    `SELECT tokens, capacity, refill_per_sec FROM provider_limits WHERE provider = $1`,
    [provider]
  );
  const r = rows[0];
  return r
    ? {
        tokens: Number(r.tokens),
        capacity: Number(r.capacity),
        refillPerSec: Number(r.refill_per_sec),
      }
    : null;
}