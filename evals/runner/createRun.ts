/**
 * Create a run and its unit rows. Units are the queue: one row per
 * (task, model_version, sample_idx).
 */
import { randomUUID } from "node:crypto";
import { TASKS, datasetHash } from "../datasets/codefix-v1/manifest.ts";
import { pool } from "./cache.ts";

export interface CreateRunOptions {
  modelVersions: string[];
  /** sample_idx values, e.g. [0] for step 2 or [0,1,2] for step 3 */
  sampleIdxs?: number[];
  maxDurationMs?: number;
  runId?: string;
}

export async function createRun(opts: CreateRunOptions): Promise<{ runId: string; units: number }> {
  const samples = opts.sampleIdxs ?? [0];
  const runId = opts.runId ?? randomUUID();

  await pool.query(
    `INSERT INTO runs (id, state, dataset_hash, max_duration_ms)
     VALUES ($1,'running',$2,$3)`,
    [runId, datasetHash(), opts.maxDurationMs ?? 3_600_000]
  );

  let units = 0;
  for (const model of opts.modelVersions) {
    for (const task of TASKS) {
      for (const s of samples) {
        await pool.query(
          `INSERT INTO units (run_id, task_id, model_version, sample_idx, state)
           VALUES ($1,$2,$3,$4,'pending')
           ON CONFLICT (run_id, task_id, model_version, sample_idx) DO NOTHING`,
          [runId, task.id, model, s]
        );
        units++;
      }
    }
  }
  return { runId, units };
}

/** Mark a run complete if nothing is left to do. */
export async function finalizeIfDone(runId: string): Promise<boolean> {
  const { rows } = await pool.query<{ pending: string }>(
    `SELECT count(*)::text AS pending FROM units WHERE run_id=$1 AND state <> 'done'`,
    [runId]
  );
  if (Number(rows[0]!.pending) > 0) return false;
  await pool.query(
    `UPDATE runs SET state='complete', finished_at=now() WHERE id=$1 AND state <> 'complete'`,
    [runId]
  );
  return true;
}