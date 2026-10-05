/**
 * Aggregates scores into per-model pass rates with bootstrap confidence
 * intervals. No dependencies: the bootstrap is a few thousand resamples of a
 * 0/1 vector, which is trivially cheap.
 */
import { pool } from "../runner/cache.ts";

export interface ModelStats {
  model_version: string;
  n: number;
  passed: number;
  passRate: number;
  ci95: [number, number];
  meanTokens: number | null;
  samples: number;
  tasks: number;
}

export interface RunStats {
  runId: string;
  state: string;
  startedAt: string | null;
  finishedAt: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  durationMs: number | null;
  models: ModelStats[];
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * Percentile bootstrap CI for a proportion. Deterministic: seeded LCG so two
 * calls on the same data always produce the same interval (a CI that moves on
 * re-read is useless for a CI gate).
 */
export function bootstrapCI(
  values: boolean[],
  resamples = 2000,
  alpha = 0.05,
  seed = 42
): [number, number] {
  const n = values.length;
  if (n === 0) return [0, 0];
  if (n === 1) return [values[0] ? 1 : 0, values[0] ? 1 : 0];

  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  const rates: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let hits = 0;
    for (let i = 0; i < n; i++) {
      if (values[Math.floor(rand() * n)]! ) hits++;
    }
    rates.push(hits / n);
  }
  rates.sort((a, b) => a - b);
  const lo = Math.floor((alpha / 2) * resamples);
  const hi = Math.ceil((1 - alpha / 2) * resamples) - 1;
  return [rates[lo] ?? 0, rates[hi] ?? 1];
}

export async function statsForRun(runId: string): Promise<RunStats> {
  const run = await pool.query<{
    state: string;
    started_at: Date;
    finished_at: Date | null;
    total_input_tokens: number;
    total_output_tokens: number;
  }>(
    `SELECT state, started_at, finished_at, total_input_tokens, total_output_tokens
       FROM runs WHERE id=$1`,
    [runId]
  );
  const r = run.rows[0];
  if (!r) throw new Error(`no run ${runId}`);

  const { rows } = await pool.query<{
    model_version: string;
    passed: boolean[];
    tasks: string;
    samples: string;
  }>(
    `SELECT model_version,
            array_agg(passed ORDER BY task_id, sample_idx) AS passed,
            count(DISTINCT task_id)::text AS tasks,
            count(DISTINCT sample_idx)::text AS samples
       FROM scores
      WHERE run_id = $1
      GROUP BY model_version
      ORDER BY model_version`,
    [runId]
  );

  const models: ModelStats[] = rows.map((row) => {
    const ci = bootstrapCI(row.passed);
    return {
      model_version: row.model_version,
      n: row.passed.length,
      passed: row.passed.filter(Boolean).length,
      passRate: mean(row.passed.map((p) => (p ? 1 : 0))),
      ci95: ci,
      meanTokens: null,
      samples: Number(row.samples),
      tasks: Number(row.tasks),
    };
  });

  const finished = r.finished_at ? r.finished_at.getTime() : null;
  return {
    runId,
    state: r.state,
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
    totalInputTokens: Number(r.total_input_tokens),
    totalOutputTokens: Number(r.total_output_tokens),
    durationMs: finished ? finished - r.started_at.getTime() : null,
    models,
  };
}

/** Per-task pass matrix, for spotting WHERE models disagree. */
export async function taskMatrix(
  runId: string
): Promise<{ task_id: string; passed: Record<string, boolean> }[]> {
  const { rows } = await pool.query<{ task_id: string; model_version: string; passed: boolean }>(
    `SELECT task_id, model_version, passed FROM scores
      WHERE run_id=$1 ORDER BY task_id, model_version, sample_idx`,
    [runId]
  );
  const byTask = new Map<string, Record<string, boolean>>();
  for (const row of rows) {
    const cur = byTask.get(row.task_id) ?? {};
    // A task counts as passed for a model only if EVERY sample passed.
    cur[row.model_version] = (cur[row.model_version] ?? true) && row.passed;
    byTask.set(row.task_id, cur);
  }
  return [...byTask.entries()].map(([task_id, passed]) => ({ task_id, passed }));
}