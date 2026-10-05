import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export type Task = {
  id: string;
  type: "bugfix" | "feature" | "refactor";
  scoring: "programmatic" | "judge";
  instruction: string;
  input_file: string;
  code: string;
  tests: string;
  /**
   * Hand-written correct solution. Optional for programmatic tasks, REQUIRED for
   * judge tasks (the judge grades against it). Keeping it here rather than
   * passing it as a function argument means a judge task cannot be constructed
   * without its ground truth.
   */
  reference?: string;
  /** Hidden tests appended at score time. */
  private_tests?: string;
};

const manifest = JSON.parse(
  readFileSync(path.join(here, "manifest.json"), "utf8")
) as {
  dataset: string;
  system_prompt: string;
  defaults: { scoring: Task["scoring"]; temperature: number; max_tokens: number };
};

export const SYSTEM_PROMPT = manifest.system_prompt;

export const TASKS: Task[] = readFileSync(path.join(here, "tasks.jsonl"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Task);

export function taskById(id: string): Task {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
}

/** Hash of the dataset CONTENT, not of a version string. */
export function datasetHash(): string {
  const raw = readFileSync(path.join(here, "tasks.jsonl"), "utf8") + SYSTEM_PROMPT;
  return createHash("sha256").update(raw).digest("hex");
}

/** The user prompt for a task: instruction + the broken code. */
export function buildPrompt(task: Task): string {
  return [
    task.instruction,
    "",
    `File: ${task.input_file}`,
    "",
    "```python",
    task.code,
    "```",
  ].join("\n");
}