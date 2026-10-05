/**
 * Negative control for the scorer: the ORIGINAL broken code for t01 must FAIL
 * inside the sandbox. If this passes, the scorer is rubber-stamping and every
 * positive result is meaningless.
 */
import "dotenv/config";
import { taskById } from "../evals/datasets/codefix-v1/manifest.ts";
import { scorerFor } from "../evals/scorer/index.ts";

const task = taskById(process.argv[2] ?? "t01");
const result = await scorerFor(task)(task, task.code); // the broken input, not a fix

console.log(`task=${task.id} broken code -> passed=${result.passed} exit=${result.raw_output.split("\n")[0]}`);
if (result.passed) {
  console.error(`FAIL  scorer accepted the known-broken code for ${task.id}`);
  process.exit(1);
}
console.log(`PASS  scorer rejected the known-broken code for ${task.id}`);