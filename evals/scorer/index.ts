import type { Task } from "../datasets/codefix-v1/manifest.ts";

export interface ScoreResult {
  mode: "programmatic" | "judge";
  passed: boolean;
  score: number | null;
  judge_model: string | null;
  rubric_hash: string | null;
  raw_output: string;
}

export type Scorer = (task: Task, modelOutput: string) => Promise<ScoreResult>;

import { programmatic } from "./programmatic.ts";
import { judge } from "./judge.ts";

/**
 * Route by task.scoring. runUnit only persists what this returns.
 *
 * `judge` needs task.reference (see manifest.ts): the judge grades against a
 * hand-written fix, so a judge task without one is a configuration error and
 * fails loudly in judge.ts rather than scoring against nothing.
 */
const SCORERS: Record<Task["scoring"], Scorer> = {
  programmatic,
  judge,
};

export function scorerFor(task: Task): Scorer {
  const s = SCORERS[task.scoring];
  if (!s) throw new Error(`unknown scoring mode "${task.scoring}" on task ${task.id}`);
  return s;
}

export { programmatic, judge };