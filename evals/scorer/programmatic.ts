import type { Task } from "../datasets/codefix-v1/manifest.ts";
import { runInSandbox } from "../sandbox/run.ts";
import type { ScoreResult } from "./index.ts";

/**
 * Run the model's code against the task's tests inside the docker sandbox.
 * passed = pytest exited 0. Nothing about the model is trusted here.
 */
export async function programmatic(task: Task, modelOutput: string): Promise<ScoreResult> {
  const code = stripFences(modelOutput);
  const result = await runInSandbox(
    {
      [task.input_file]: code,
      "test_solution.py": task.tests,
    },
    ["-m", "pytest", "-q", "-p", "no:cacheprovider", "test_solution.py"]
  );

  const raw = [
    `exit_code=${result.exitCode}`,
    `duration_ms=${result.durationMs}`,
    "--- stdout ---",
    result.stdout.trim(),
    "--- stderr ---",
    result.stderr.trim(),
  ].join("\n");

  return {
    mode: "programmatic",
    passed: result.exitCode === 0,
    score: result.exitCode === 0 ? 1 : 0,
    judge_model: null,
    rubric_hash: null,
    raw_output: raw.slice(0, 20_000),
  };
}

/** Models wrap code in ```python fences roughly always. Unwrap before writing. */
export function stripFences(text: string): string {
  const m = text.match(/```(?:python|py)?\s*\n([\s\S]*?)```/);
  return (m?.[1] ?? text).trim() + "\n";
}