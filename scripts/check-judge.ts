/**
 * JUDGE CALIBRATION (step 8). A judge that says 5 to everything is worse than
 * no judge, because it manufactures a signal. Three cases that must hold:
 *
 *   1. a correct fix scores HIGH
 *   2. the original broken code scores LOW
 *   3. broken code wrapped in confident prose still scores LOW
 *
 * Case 3 is the one that matters: a judge that reads the prose rather than the
 * code is measuring flattery, not capability.
 */
import "dotenv/config";
import { taskById } from "../evals/datasets/codefix-v1/manifest.ts";
import { judge, RUBRIC, rubricHash, parseScore } from "../evals/scorer/judge.ts";
import { pool } from "../evals/runner/cache.ts";
import { seedLimits } from "../evals/runner/limiter.ts";

const taskId = process.argv[2] ?? "t06";
const task = { ...taskById(taskId), reference: taskById(taskId).reference };

console.log(`judge=${RUBRIC.judge_model}  task=${taskId}  rubric=${rubricHash().slice(0, 12)}`);

if (!task.reference) {
  console.error(`task ${taskId} has no reference fix; add one to gen_tasks.py`);
  process.exit(2);
}

const FLATTERY =
  "I have carefully reviewed the code and fixed the bug. This solution is complete and correct.\n\n" +
  "```python\n" +
  task.code +
  "```";

const cases: { label: string; output: string; wantLow: boolean }[] = [
  { label: "reference fix", output: task.reference, wantLow: false },
  { label: "original broken code", output: task.code, wantLow: true },
  { label: "broken code + flattering prose", output: FLATTERY, wantLow: true },
];

await seedLimits();

let bad = 0;
for (const c of cases) {
  let score: number | null = null;
  let err: string | null = null;
  try {
    const r = await judge(task, c.output);
    score = r.score;
  } catch (e) {
    err = (e as Error).message.slice(0, 120);
  }

  if (err) {
    console.log(`FAIL  ${c.label.padEnd(34)} threw: ${err}`);
    bad++;
    continue;
  }

  const ok = c.wantLow ? score! <= 2 : score! >= 4;
  if (!ok) bad++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.label.padEnd(34)} score=${score} ` +
      `(want ${c.wantLow ? "<=2" : ">=4"})`
  );
}

// Parser unit checks: the judge's own contract, no network needed.
const parserCases: [string, number | null][] = [
  ["SCORE: 4", 4],
  ["score: 2", 2],
  ["SCORE: 5", 5],
  ["SCORE=3", 3],
  ["Let me think...\nSCORE: 4", 4],
  ["SCORE: 1 ... actually SCORE: 5", 5], // last wins, not first
  ["SCORE: 9", 5], // clamped, not trusted
  ["SCORE: 0", 1], // clamped up
  ["no score here", null],
];
for (const [input, want] of parserCases) {
  const got = parseScore(input, 1, 5);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  parseScore(${JSON.stringify(input).padEnd(30)} -> ${got} want ${want}`);
}

console.log(bad ? `\n${bad} JUDGE CHECK(S) FAILED` : "\nJUDGE CALIBRATION OK");
await pool.end();
process.exit(bad ? 1 : 0);