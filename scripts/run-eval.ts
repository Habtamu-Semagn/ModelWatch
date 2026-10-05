/**
 * Create a run and (optionally) drive it to completion with the worker.
 *
 *   npx tsx scripts/run-eval.ts --models=qwen/qwen3.8-27b --samples=0
 *   npx tsx scripts/run-eval.ts --models=qwen/qwen3.8-27b,gemini-2.5-flash --samples=0,1,2
 */
import "dotenv/config";
import { createRun } from "../evals/runner/createRun.ts";
import { runWorker } from "../evals/runner/worker.ts";
import { pool } from "../evals/runner/cache.ts";
import { MODEL_VERSIONS } from "../evals/adapters/index.ts";

function arg(name: string, fallback: string): string {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
}

const models = arg("models", "qwen/qwen3.8-27b").split(",").filter(Boolean);
const samples = arg("samples", "0").split(",").map(Number);
const dryRun = process.argv.includes("--dry-run");

for (const m of models) {
  if (!MODEL_VERSIONS.includes(m)) {
    console.error(`unknown model_version "${m}". registered: ${MODEL_VERSIONS.join(", ")}`);
    process.exit(2);
  }
}

const { runId, units } = await createRun({ modelVersions: models, sampleIdxs: samples });
console.log(`run ${runId}: ${units} units (${models.length} model(s) x 15 tasks x ${samples.length} sample(s))`);

if (dryRun) {
  console.log("dry run: not starting worker");
  await pool.end();
  process.exit(0);
}

const t0 = Date.now();
let pass = 0;
const byModel = new Map<string, { p: number; n: number }>();

await runWorker({
  runId,
  temperature: Number(arg("temperature", "0")),
      // Groq enforces OTPM=1000 output tokens/min PER REQUEST: a request asking for
      // more than that is rejected outright with 429 regardless of rate. Tasks here
      // produce ~50-200 token patches, so 512 is ample and stays under the ceiling.
      maxTokens: Number(arg("max-tokens", "512")),
  onUnitDone: (u, passed, cacheHit, ms) => {
    if (passed) pass++;
    const cur = byModel.get(u.model_version) ?? { p: 0, n: 0 };
    cur.n++;
    if (passed) cur.p++;
    byModel.set(u.model_version, cur);
    console.log(
      `[worker] ${u.task_id} ${u.model_version} s${u.sample_idx} ` +
        `${passed ? "PASS" : "FAIL"}${cacheHit ? " (cached)" : ""} ${ms}ms`
    );
  },
  onUnitError: (u, e) =>
    console.error(`[worker] ERROR ${u.task_id}/${u.model_version}/s${u.sample_idx}: ${(e as Error)?.message ?? e}`),
});

const { rows } = await pool.query<{ state: string; passed: boolean | null; model_version: string }>(
  `SELECT u.state, s.passed, s.model_version
     FROM units u LEFT JOIN scores s
       ON (u.run_id, u.task_id, u.model_version, u.sample_idx) =
          (s.run_id, s.task_id, s.model_version, s.sample_idx)
    WHERE u.run_id = $1`,
  [runId]
);

const counts = rows.reduce(
  (acc, r) => ((acc[r.state] = (acc[r.state] ?? 0) + 1), acc),
  {} as Record<string, number>
);

console.log(`\n=== run ${runId} ===`);
console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`unit states: ${JSON.stringify(counts)}`);
for (const [m, v] of byModel) {
  console.log(`  ${m}: ${v.p}/${v.n} passed (${((v.p / v.n) * 100).toFixed(0)}%)`);
}
console.log(`overall: ${pass}/${rows.length}`);

const tok = await pool.query<{ total_input_tokens: number; total_output_tokens: number }>(
  `SELECT total_input_tokens, total_output_tokens FROM runs WHERE id=$1`,
  [runId]
);
console.log(`tokens: in=${tok.rows[0]?.total_input_tokens} out=${tok.rows[0]?.total_output_tokens}`);

await pool.end();
process.exit(counts.failed ? 1 : 0);