/**
 * ONE worker process. The queue IS the units table:
 *
 *   UPDATE units SET state='running', attempts=attempts+1
 *    WHERE (run_id, task_id, model_version, sample_idx) = (
 *      SELECT ... FROM units WHERE state='pending' ORDER BY run_id, task_id
 *        FOR UPDATE SKIP LOCKED LIMIT 1)
 *   RETURNING *;
 *
 * FOR UPDATE SKIP LOCKED is what makes this safe to run twice: a second worker
 * skips locked rows instead of blocking or double-claiming. No Redis, no pg-boss.
 */
import "dotenv/config";
import { pool } from "./cache.ts";
import { runUnit, type UnitRow, type RunUnitOptions } from "./runUnit.ts";
import { seedLimits, peek } from "./limiter.ts";
import { finalizeIfDone } from "./createRun.ts";
import { AdapterError } from "../adapters/types.ts";

export interface WorkerOptions extends RunUnitOptions {
  runId?: string;
  pollMs?: number;
  maxAttempts?: number;
  onUnitDone?: (u: UnitRow, passed: boolean, cacheHit: boolean, ms: number) => void;
  onUnitError?: (u: UnitRow, err: unknown) => void;
}

/**
 * Rate-limit and upstream-unavailable responses are NOT unit failures. They
 * must not consume the attempt budget, or a run exhausts its retries in the
 * first minute of a quota window and marks everything 'failed' while the model
 * was never actually given a chance.
 */
function isRetryable(err: unknown): boolean {
  return err instanceof AdapterError && (err.status === 429 || err.status === 503);
}

/** Read Retry-After if the provider sent one, else a bounded exponential wait. */
function retryDelayMs(attempt: number, err: unknown): number {
  const header = (err as { retryAfterSeconds?: number })?.retryAfterSeconds;
  if (typeof header === "number" && header > 0) {
    return Math.min(header * 1000, 300_000);
  }
  return Math.min(2000 * 2 ** attempt, 60_000);
}

export async function runWorker(opts: WorkerOptions): Promise<void> {
  const pollMs = opts.pollMs ?? 1000;
  const maxAttempts = opts.maxAttempts ?? 3;
  await seedLimits();

  let done = 0;
  for (;;) {
    const claimed = await claimNext(opts.runId);
    if (!claimed) {
      if (opts.runId && (await finalizeIfDone(opts.runId))) {
        console.log(`[worker] run ${opts.runId} complete after ${done} units`);
        return;
      }
      await sleep(pollMs);
      continue;
    }

    const started = Date.now();
    // Retry rate limits INLINE with backoff, keeping the unit claimed. This
    // avoids churning the attempts counter and re-queueing behind other units.
    for (let retry = 0; ; retry++) {
      try {
        const r = await runUnit(claimed, opts);
        done++;
        opts.onUnitDone?.(claimed, r.score.passed, r.cacheHit, Date.now() - started);
        break;
      } catch (err) {
        if (isRetryable(err) && retry < MAX_INLINE_RETRIES) {
          const wait = retryDelayMs(retry, err);
          console.error(
            `[worker] ${(err as AdapterError).status} on ${claimed.task_id}/` +
              `${claimed.model_version}; retrying in ${wait}ms (attempt ${retry + 1})`
          );
          await sleep(wait);
          continue;
        }

        opts.onUnitError?.(claimed, err);
        const { rows } = await pool.query<{ attempts: number }>(
          `SELECT attempts FROM units
            WHERE run_id=$1 AND task_id=$2 AND model_version=$3 AND sample_idx=$4`,
          [claimed.run_id, claimed.task_id, claimed.model_version, claimed.sample_idx]
        );
        const attempts = rows[0]?.attempts ?? maxAttempts;
        // Only genuine failures count against the attempt budget.
        await pool.query(
          `UPDATE units SET state = CASE WHEN attempts >= $5 THEN 'failed' ELSE 'pending' END
            WHERE run_id=$1 AND task_id=$2 AND model_version=$3 AND sample_idx=$4`,
          [claimed.run_id, claimed.task_id, claimed.model_version, claimed.sample_idx, maxAttempts]
        );
        console.error(
          `[worker] unit ${claimed.task_id}/${claimed.model_version}/s${claimed.sample_idx} failed ` +
            `(attempt ${attempts}): ${(err as Error)?.message ?? err}`
        );
        break;
      }
    }
  }
}

/** Bounded: a daily quota cannot be waited out inside one process lifetime. */
const MAX_INLINE_RETRIES = 4;

/** Atomically move one pending unit to running. null = nothing left to claim. */
export async function claimNext(runId?: string): Promise<UnitRow | null> {
  const { rows } = await pool.query<UnitRow>(
    `UPDATE units SET state = 'running', attempts = attempts + 1
      WHERE (run_id, task_id, model_version, sample_idx) = (
        SELECT run_id, task_id, model_version, sample_idx
          FROM units
         WHERE state = 'pending' ${runId ? "AND run_id = $1" : ""}
         ORDER BY run_id, task_id, model_version, sample_idx
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING run_id, task_id, model_version, sample_idx, state, attempts`,
    runId ? [runId] : []
  );
  return rows[0] ?? null;
}

/**
 * Reclaim units stranded in 'running' by a killed worker.
 *
 * Unconditional: a 'running' row at startup means the previous worker DIED
 * holding it, which is not the unit's fault and must not consume its attempt
 * budget. Provider failures are handled separately (they decrement via the
 * attempts counter in the error path).
 */
export async function reclaimStranded(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE units SET state = 'pending' WHERE state = 'running'`
  );
  return rowCount ?? 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// CLI: npm run worker -- --run-id=<uuid>
if (process.argv[1]?.endsWith("worker.ts")) {
  const runId = process.argv.find((a) => a.startsWith("--run-id="))?.split("=")[1];
  const stranded = await reclaimStranded();
  if (stranded) console.log(`[worker] reclaimed ${stranded} stranded unit(s) from a dead worker`);
  console.log("[worker] groq bucket:", JSON.stringify(await peek("groq")));
  console.log("[worker] google bucket:", JSON.stringify(await peek("google")));

  await runWorker({
    runId,
    temperature: Number(process.env.TEMPERATURE ?? 0),
    maxTokens: Number(process.env.MAX_TOKENS ?? 512),
    onUnitDone: (u, passed, cacheHit, ms) =>
      console.log(
        `[worker] ${u.task_id} ${u.model_version} s${u.sample_idx} ` +
          `${passed ? "PASS" : "FAIL"}${cacheHit ? " (cached)" : ""} ${ms}ms`
      ),
  });
  await pool.end();
}