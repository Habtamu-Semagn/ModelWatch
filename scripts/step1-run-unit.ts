/**
 * STEP 1 PROOF
 * One task (t01), one Groq model (qwen-2.5-coder-32b), sample 0.
 * Runs runUnit TWICE and asserts:
 *   - run 1 is a cache miss (adapter called)
 *   - run 2 is a cache hit (no second provider call)
 *   - exactly ONE score row exists for the unit
 *   - passed = true
 *
 * Usage: npm run step1                    (live Groq call, needs GROQ_API_KEY)
 *        npm run step1 -- --offline       (local stub adapter, proves plumbing only)
 *        npm run step1 -- --fresh         (wipe prior state first, so run 1 is a true miss)
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { runUnit, type UnitRow } from "../evals/runner/runUnit.ts";
import { pool } from "../evals/runner/cache.ts";
import { datasetHash } from "../evals/datasets/codefix-v1/manifest.ts";
import { registerStub } from "./_stubAdapter.ts";

const TASK_ID = "t01";
// Registry keys are the exact model_version strings; keep in sync with evals/adapters/index.ts.
const MODEL = process.env.STEP1_MODEL ?? "qwen/qwen3.8-27b";
const SAMPLE_IDX = 0;
const TEMPERATURE = 0;
const MAX_TOKENS = 2048;

const offline = process.argv.includes("--offline");
const fresh = process.argv.includes("--fresh");
if (offline) registerStub();

function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

async function countScores(runId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM scores
      WHERE run_id=$1 AND task_id=$2 AND model_version=$3 AND sample_idx=$4`,
    [runId, TASK_ID, MODEL, SAMPLE_IDX]
  );
  return Number(rows[0]!.n);
}

async function main() {
  if (!offline && !process.env.GROQ_API_KEY) {
    console.error("GROQ_API_KEY not set. Put it in .env, or run with --offline.");
    process.exit(2);
  }

  const runId = randomUUID();
  if (fresh) {
    await pool.query(`TRUNCATE scores, units, runs, cache`);
    console.log("[--fresh] truncated scores, units, runs, cache");
  }
  await pool.query(
    `INSERT INTO runs (id, state, dataset_hash) VALUES ($1,'running',$2)`,
    [runId, datasetHash()]
  );
  await pool.query(
    `INSERT INTO units (run_id, task_id, model_version, sample_idx, state, attempts)
     VALUES ($1,$2,$3,$4,'running',1)
     ON CONFLICT (run_id, task_id, model_version, sample_idx) DO NOTHING`,
    [runId, TASK_ID, MODEL, SAMPLE_IDX]
  );

  const unit: UnitRow = {
    run_id: runId,
    task_id: TASK_ID,
    model_version: MODEL,
    sample_idx: SAMPLE_IDX,
  };
  const opts = { temperature: TEMPERATURE, maxTokens: MAX_TOKENS };

  console.log(`\n=== run 1 (${offline ? "OFFLINE stub" : "live groq"}) ===`);
  const r1 = await runUnit(unit, opts);
  console.log(`cache_hit=${r1.cacheHit} passed=${r1.score.passed} tokens=${r1.inputTokens}/${r1.outputTokens}`);
  console.log(`model output:\n${r1.output.slice(0, 400)}`);
  console.log(`sandbox:\n${(await pool.query<{ raw_output: string }>(
    `SELECT raw_output FROM scores WHERE run_id=$1 AND task_id=$2 AND model_version=$3 AND sample_idx=$4`,
    [runId, TASK_ID, MODEL, SAMPLE_IDX])).rows[0]!.raw_output}`);

  console.log(`\n=== run 2 (same unit, same key) ===`);
  const r2 = await runUnit(unit, opts);
  console.log(`cache_hit=${r2.cacheHit} passed=${r2.score.passed} tokens=${r2.inputTokens}/${r2.outputTokens}`);

  const n = await countScores(runId);
  await pool.query(`UPDATE runs SET state='complete', finished_at=now() WHERE id=$1`, [runId]);

  console.log("");
  check("run 1 was a cache miss", r1.cacheHit === false);
  check("run 2 was a cache HIT", r2.cacheHit === true);
  check("run 2 made no provider call (0 new tokens)", r2.inputTokens === r1.inputTokens && r2.outputTokens === r1.outputTokens);
  check("scorer ran (passed=true)", r1.score.passed === true, `passed=${r1.score.passed}`);
  check("exactly 1 score row", n === 1, `rows=${n}`);
  check("unit state = done", (await pool.query<{ state: string }>(
    `SELECT state FROM units WHERE run_id=$1 AND task_id=$2 AND model_version=$3 AND sample_idx=$4`,
    [runId, TASK_ID, MODEL, SAMPLE_IDX])).rows[0]!.state === "done");
  check("run marked complete", (await pool.query<{ state: string }>(
    `SELECT state FROM runs WHERE id=$1`, [runId])).rows[0]!.state === "complete");

  console.log(`\nrun_id=${runId}`);
  await pool.end();
  console.log(process.exitCode ? "\nSTEP 1 FAILED" : "\nSTEP 1 OK");
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});