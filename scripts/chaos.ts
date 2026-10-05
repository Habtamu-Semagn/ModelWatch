/**
 * CHAOS TEST (step 7). kill -9 the worker mid-run, restart it, and assert:
 *   1. no duplicate score rows for any unit
 *   2. no unit left stuck in 'running'
 *   3. the run reaches state='complete'
 *   4. the cache made the restarted worker cheaper (kills are never free)
 *
 * Run: npx tsx scripts/chaos.ts
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../evals/runner/cache.ts";
import { createRun } from "../evals/runner/createRun.ts";
import { TASKS } from "../evals/datasets/codefix-v1/manifest.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, "..", "evals", "runner", "worker.ts");
const MODEL = process.env.CHAOS_MODEL ?? "qwen/qwen3.8-27b";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function unitsSnapshot(runId: string) {
  const { rows } = await pool.query<{ state: string; n: string }>(
    `SELECT state, count(*)::text AS n FROM units WHERE run_id=$1 GROUP BY state`,
    [runId]
  );
  return Object.fromEntries(rows.map((r) => [r.state, Number(r.n)])) as Record<string, number>;
}

function startWorker(runId: string): ReturnType<typeof spawn> {
  const p = spawn("npx", ["tsx", WORKER, `--run-id=${runId}`], {
    env: { ...process.env, TEMPERATURE: "0", MAX_TOKENS: "512" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout?.on("data", (d) => process.stdout.write(`[w1] ${d}`));
  p.stderr?.on("data", (d) => process.stderr.write(`[w1!] ${d}`));
  return p;
}

const { runId, units } = await createRun({ modelVersions: [MODEL], sampleIdxs: [0] });
console.log(`chaos run ${runId}: ${units} units, model ${MODEL}\n`);

const first = startWorker(runId);

// Let it get a few units in, then SIGKILL — no cleanup, no chance to release locks.
await sleep(Number(process.env.CHAOS_KILL_AFTER_MS ?? 9000));
console.log(`\n=== kill -9 worker after ${process.env.CHAOS_KILL_AFTER_MS ?? 9000}ms ===`);
const midStates = await unitsSnapshot(runId);
console.log(`states at kill: ${JSON.stringify(midStates)}`);
first.kill("SIGKILL");
await new Promise<void>((resolve) => first.on("exit", () => resolve()));
console.log(`worker 1 killed (pid ${first.pid})`);

const stranded = midStates.running ?? 0;
console.log(`stranded 'running' units to reclaim: ${stranded}\n`);

// Restart. reclaimStranded() puts them back in the queue.
const second = startWorker(runId);

const deadline = Date.now() + Number(process.env.CHAOS_TIMEOUT_MS ?? 600_000);
let done = false;
while (Date.now() < deadline) {
  await sleep(3000);
  const s = await unitsSnapshot(runId);
  const doneN = s.done ?? 0;
  process.stdout.write(`progress: ${doneN}/${units} done\r\n`);
  if (doneN >= units) {
    done = true;
    break;
  }
}
console.log("\n");

const final = await unitsSnapshot(runId);
const run = await pool.query<{ state: string }>(`SELECT state FROM runs WHERE id=$1`, [runId]);

const dupes = await pool.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM (
     SELECT run_id, task_id, model_version, sample_idx FROM scores
      WHERE run_id=$1
      GROUP BY 1,2,3,4 HAVING count(*) > 1) d`,
  [runId]
);
const scoreRows = await pool.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM scores WHERE run_id=$1`,
  [runId]
);
const cacheRows = await pool.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM cache WHERE model_version=$1`,
  [MODEL]
);

second.kill("SIGTERM");

check("worker 1 was actually killed mid-run", stranded > 0, `stranded=${stranded}`);
check("no duplicate score rows", Number(dupes.rows[0]?.n ?? 0) === 0, `dupes=${dupes.rows[0]?.n}`);
check(
  "exactly one score row per unit",
  Number(scoreRows.rows[0]?.n ?? 0) === units,
  `rows=${scoreRows.rows[0]?.n}/${units}`
);
check("no unit stuck in 'running'", (final.running ?? 0) === 0, JSON.stringify(final));
check("all units done", (final.done ?? 0) === units, JSON.stringify(final));
check("run reached complete", run.rows[0]?.state === "complete", run.rows[0]?.state ?? "?");
check(
  "cache has <= one entry per unit (kills did not multiply provider calls)",
  Number(cacheRows.rows[0]?.n ?? 0) <= units,
  `cache=${cacheRows.rows[0]?.n}/${units}`
);

await pool.end();
console.log(failures ? `\nCHAOS FAILED (${failures})` : "\nCHAOS OK");
process.exit(failures ? 1 : 0);