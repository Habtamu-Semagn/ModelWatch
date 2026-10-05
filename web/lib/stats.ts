/** Shared stats math. Mirrors evals/stats/* — no imports across the app boundary. */
import { pool } from "./db";

export interface ModelStats {
  model_version: string;
  n: number;
  passed: number;
  passRate: number;
  ci95: [number, number];
  tasks: number;
  samples: number;
}

export interface RunDetail {
  runId: string;
  state: string;
  startedAt: string | null;
  finishedAt: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  models: ModelStats[];
  matrix: { task_id: string; passed: Record<string, boolean> }[];
  units: { state: string; n: number }[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

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
    for (let i = 0; i < n; i++) if (values[Math.floor(rand() * n)]!) hits++;
    rates.push(hits / n);
  }
  rates.sort((a, b) => a - b);
  return [
    rates[Math.floor((alpha / 2) * resamples)] ?? 0,
    rates[Math.ceil((1 - alpha / 2) * resamples) - 1] ?? 1,
  ];
}

export async function runDetail(runId: string): Promise<RunDetail | null> {
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
  if (!r) return null;

  const agg = await pool.query<{
    model_version: string;
    passed: boolean[];
    tasks: string;
    samples: string;
  }>(
    `SELECT model_version,
            array_agg(passed ORDER BY task_id, sample_idx) AS passed,
            count(DISTINCT task_id)::text AS tasks,
            count(DISTINCT sample_idx)::text AS samples
       FROM scores WHERE run_id=$1
      GROUP BY model_version ORDER BY model_version`,
    [runId]
  );

  const models: ModelStats[] = agg.rows.map((row) => ({
    model_version: row.model_version,
    n: row.passed.length,
    passed: row.passed.filter(Boolean).length,
    passRate: mean(row.passed.map((p) => (p ? 1 : 0))),
    ci95: bootstrapCI(row.passed),
    tasks: Number(row.tasks),
    samples: Number(row.samples),
  }));

  const raw = await pool.query<{ task_id: string; model_version: string; passed: boolean }>(
    `SELECT task_id, model_version, passed FROM scores
      WHERE run_id=$1 ORDER BY task_id, model_version, sample_idx`,
    [runId]
  );
  const byTask = new Map<string, Record<string, boolean>>();
  for (const row of raw.rows) {
    const cur = byTask.get(row.task_id) ?? {};
    // passed for the task only if EVERY sample passed
    cur[row.model_version] = (cur[row.model_version] ?? true) && row.passed;
    byTask.set(row.task_id, cur);
  }

  const units = await pool.query<{ state: string; n: string }>(
    `SELECT state, count(*)::text AS n FROM units WHERE run_id=$1 GROUP BY state`,
    [runId]
  );

  return {
    runId,
    state: r.state,
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
    totalInputTokens: Number(r.total_input_tokens),
    totalOutputTokens: Number(r.total_output_tokens),
    models,
    matrix: [...byTask.entries()].map(([task_id, passed]) => ({ task_id, passed })),
    units: units.rows.map((u) => ({ state: u.state, n: Number(u.n) })),
  };
}

export async function listRuns(limit = 25) {
  const { rows } = await pool.query<{
    id: string;
    state: string;
    started_at: Date;
    finished_at: Date | null;
    total_input_tokens: number;
    total_output_tokens: number;
    models: string[];
    units_done: string;
    units_total: string;
  }>(
    `SELECT r.id, r.state, r.started_at, r.finished_at,
            r.total_input_tokens, r.total_output_tokens,
            COALESCE(array_agg(DISTINCT u.model_version) FILTER (WHERE u.model_version IS NOT NULL), '{}') AS models,
            count(*) FILTER (WHERE u.state='done')::text AS units_done,
            count(u.task_id)::text AS units_total
       FROM runs r LEFT JOIN units u ON u.run_id = r.id
      GROUP BY r.id ORDER BY r.started_at DESC LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({
    id: r.id,
    state: r.state,
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
    totalInputTokens: Number(r.total_input_tokens),
    totalOutputTokens: Number(r.total_output_tokens),
    models: r.models,
    unitsDone: Number(r.units_done),
    unitsTotal: Number(r.units_total),
  }));
}