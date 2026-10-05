/**
 * Dataset self-check (no model involved). For all 15 tasks:
 *   - the SHIPPED broken code must FAIL its tests (otherwise the task is a free pass)
 *   - the task's OWN "reference" field must PASS (otherwise the task is
 *     impossible, and judge scoring has no valid ground truth)
 * Both run through the real docker sandbox.
 *
 * The reference is read from tasks.jsonl, not a second hardcoded map here, so
 * there is exactly one definition of "correct" per task — used by both the
 * sandbox check and the judge prompt. Those are hand-written in
 * scripts/gen_tasks.py, NOT copied from model output: a reference taken from a
 * model would grade the model against its own idea of correct.
 */
import "dotenv/config";
import { TASKS } from "../evals/datasets/codefix-v1/manifest.ts";
import { programmatic } from "../evals/scorer/programmatic.ts";

let bad = 0;
for (const task of TASKS) {
  const fix = task.reference;
  if (!fix) {
    console.log(`FAIL  ${task.id}  no reference field (judge scoring needs one)`);
    bad++;
    continue;
  }
  const nTests = (task.tests.match(/def test_/g) ?? []).length;
  const broken = await programmatic(task, task.code);
  const fixed = await programmatic(task, fix);
  const ok = !broken.passed && fixed.passed;
  if (!ok) bad++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${task.id}  (${nTests} tests)  ` +
      `broken=${broken.passed ? "PASSED(bad)" : "failed(good)"}  ` +
      `fix=${fixed.passed ? "passed" : "FAILED(bad)"}`
  );
  if (!ok) console.log(fixed.raw_output);
}
console.log(
  bad ? `\n${bad} TASK(S) BROKEN` : `\nall ${TASKS.length} tasks: broken fails, reference passes`
);
process.exit(bad ? 1 : 0);