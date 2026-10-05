/**
 * Judge END-TO-END (step 8). Proves the judge works through the real call
 * chain, not just standalone: runUnit -> scorer routing -> judge -> scores row
 * with mode='judge', judge_model and rubric_hash populated.
 *
 * Graded on t14, the one task where the two models disagreed in the last full
 * run — the most informative single unit to check.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { runUnit } from "../evals/runner/runUnit.ts";
import { pool } from "../evals/runner/cache.ts";
import { seedLimits } from "../evals/runner/limiter.ts";
import { datasetHash, SYSTEM_PROMPT } from "../evals/datasets/codefix-v1/manifest.ts";
import { RUBRIC } from "../evals/scorer/judge.ts";

const TASK_ID = process.argv[2] ?? "t14";
const MODEL = process.env.JUDGE_EVAL_MODEL ?? "qwen/qwen3.8-27b";

await seedLimits();
const runId = randomUUID();
await pool.query(`INSERT INTO runs (id, state, dataset_hash) VALUES ($1,'running',$2)`, [
  runId,
  datasetHash(),
]);
await pool.query(
  `INSERT INTO units (run_id, task_id, model_version, sample_idx, state)
   VALUES ($1,$2,$3,0,'running') ON CONFLICT DO NOTHING`,
  [runId, TASK_ID, MODEL]
);

console.log(`run ${runId}\ntask ${TASK_ID}  model ${MODEL}  judge ${RUBRIC.judge_model}\n`);

try {
  const r = await runUnit(
    { run_id: runId, task_id: TASK_ID, model_version: MODEL, sample_idx: 0 },
    { temperature: 0, maxTokens: 512, scoringOverride: "judge" }
  );
  console.log(`cache_hit=${r.cacheHit} tokens=${r.inputTokens}/${r.outputTokens}`);
  console.log(`model said:\n${r.output.slice(0, 300)}`);
  console.log(`\nJUDGE VERDICT: mode=${r.score.mode} score=${r.score.score} passed=${r.score.passed}`);
} catch (e) {
  console.error(`runUnit threw: ${(e as Error).message}`);
  await pool.query(`DELETE FROM runs WHERE id=$1`, [runId]);
  await pool.end();
  process.exit(1);
}

const row = await pool.query<{
  mode: string;
  score: string | null;
  passed: boolean;
  judge_model: string | null;
  rubric_hash: string | null;
  raw_output: string;
}>(
  `SELECT mode, score, passed, judge_model, rubric_hash, raw_output
     FROM scores WHERE run_id=$1 AND task_id=$2 AND model_version=$3 AND sample_idx=0`,
  [runId, TASK_ID, MODEL]
);
const s = row.rows[0];

let bad = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad++;
};

check("score row exists with mode='judge'", s?.mode === "judge", s?.mode);
check("score in 1..5", Number(s?.score) >= 1 && Number(s?.score) <= 5, String(s?.score));
check("judge_model recorded", !!s?.judge_model, s?.judge_model ?? "null");
check("rubric_hash recorded", !!s?.rubric_hash, s?.rubric_hash?.slice(0, 12) ?? "null");
check("judge_model is cross-family (not groq-qwen/google)", s?.judge_model !== MODEL, `${s?.judge_model} vs ${MODEL}`);
const unit = await pool.query<{ state: string }>(
  `SELECT state FROM units WHERE run_id=$1 AND task_id=$2 AND model_version=$3`,
  [runId, TASK_ID, MODEL]
);
check("unit state = done", unit.rows[0]?.state === "done", unit.rows[0]?.state);

await pool.query(`UPDATE runs SET state='complete', finished_at=now() WHERE id=$1`, [runId]);
console.log(`\nraw_output:\n${s?.raw_output ?? ""}`);
console.log(`\nrun_id=${runId}`);
await pool.end();
console.log(bad ? `\nJUDGE E2E FAILED (${bad})` : "\nJUDGE E2E OK");
process.exit(bad ? 1 : 0);