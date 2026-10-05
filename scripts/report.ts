/**
 * Significance gate + report for a run. This is the thing that decides whether
 * a claimed model difference is real or noise.
 *
 *   npx tsx scripts/report.ts --run-id=<uuid>
 *   npx tsx scripts/report.ts --latest
 *   npx tsx scripts/report.ts --latest --gate   # exit 1 unless the comparison is significant
 */
import "dotenv/config";
import { pool } from "../evals/runner/cache.ts";
import { statsForRun, taskMatrix } from "../evals/stats/bootstrap.ts";
import { compareModels, disagreementTasks } from "../evals/stats/significance.ts";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const gate = process.argv.includes("--gate");

async function latestRunId(): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM runs ORDER BY started_at DESC LIMIT 1`
  );
  return rows[0]?.id ?? null;
}

const runId = arg("run-id") ?? (process.argv.includes("--latest") ? await latestRunId() : null);
if (!runId) {
  console.error("no run specified (--run-id=<uuid> or --latest)");
  process.exit(2);
}

const stats = await statsForRun(runId);
const matrix = await taskMatrix(runId);

console.log(`\n=== run ${runId} ===`);
console.log(`state: ${stats.state}`);
if (stats.durationMs) console.log(`duration: ${(stats.durationMs / 1000).toFixed(1)}s`);
console.log(`tokens: in=${stats.totalInputTokens} out=${stats.totalOutputTokens}`);

console.log(`\npass rate (95% bootstrap CI over units)`);
for (const m of stats.models) {
  console.log(
    `  ${m.model_version.padEnd(26)} ${String(m.passed).padStart(3)}/${String(m.n).padEnd(3)} ` +
      `${(m.passRate * 100).toFixed(1).padStart(5)}%  CI [${(m.ci95[0] * 100).toFixed(0)}, ${(m.ci95[1] * 100).toFixed(0)}]%`
  );
}

const models = stats.models.map((m) => m.model_version);
if (models.length < 2) {
  console.log("\n(single model: no comparison to gate)");
  await pool.end();
  process.exit(0);
}

console.log(`\nper-task matrix (task passes only if EVERY sample passed)`);
const head = models.map((m) => m.padEnd(12)).join("");
console.log(`  ${"task".padEnd(6)} ${head}`);
for (const row of matrix) {
  const cells = models.map((m) => (row.passed[m] ? "pass".padEnd(12) : "FAIL".padEnd(12))).join("");
  const disagree = models.some((m) => row.passed[m]) && models.some((m) => !row.passed[m]);
  console.log(`  ${row.task_id.padEnd(6)} ${cells}${disagree ? "  <-- disagreement" : ""}`);
}

// Pairwise McNemar across all model pairs.
const comparisons: { a: string; b: string; pValue: number; significant: boolean; aOnly: number; bOnly: number; disagree: number }[] = [];
for (let i = 0; i < models.length; i++) {
  for (let j = i + 1; j < models.length; j++) {
    const [a, b] = [models[i]!, models[j]!];
    const res = await compareModels(runId, a, b);
    const disagree = await disagreementTasks(runId, a, b);
    comparisons.push({
      a,
      b,
      pValue: res.pValue,
      significant: res.significant,
      aOnly: res.aOnly,
      bOnly: res.bOnly,
      disagree: disagree.length,
    });
  }
}

console.log(`\nMcNemar (paired at task level, continuity-corrected)`);
for (const c of comparisons) {
  console.log(
    `  ${c.a} vs ${c.b}: p=${c.pValue.toFixed(4)} ${c.significant ? "SIGNIFICANT" : "not significant"} ` +
      `(${c.a} only: ${c.aOnly}, ${c.b} only: ${c.bOnly}, tasks differing: ${c.disagree})`
  );
}

const anySig = comparisons.some((c) => c.significant);
console.log(
  `\nverdict: ${anySig ? "at least one pairwise difference is significant at p<0.05" : "NO significant difference between models"}`
);
if (!anySig) {
  console.log("          treat the leaderboard ordering as noise; widen the dataset or samples");
}

await pool.end();
process.exit(gate && !anySig ? 1 : 0);