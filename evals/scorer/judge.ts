/**
 * PHASE 2 judge. Grader LLM, not tests.
 *
 * Judge = Groq llama-3.3-70b-versatile. That is Meta, while the baseline is
 * Gemini (Google) — the cross-family rule. A judge from the same family as the
 * model it grades shares its blind spots, so a Qwen-scored-by-Qwen result is not
 * evidence of anything.
 *
 * The judge sees the ORIGINAL broken code, the task instruction, the reference
 * fix, and the candidate. It never sees which model produced the candidate.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adapterFor } from "../adapters/index.ts";
import { acquire } from "../runner/limiter.ts";
import type { Task } from "../datasets/codefix-v1/manifest.ts";
import type { ScoreResult } from "./index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

interface Rubric {
  version: number;
  scale: { min: number; max: number; anchors: Record<string, string> };
  judge_model: string;
  judge_temperature: number;
  max_output_tokens: number;
  guidance: string[];
  instructions: string[];
}

export const RUBRIC: Rubric = JSON.parse(
  readFileSync(path.join(here, "..", "datasets", "codefix-v1", "rubric.json"), "utf8")
) as Rubric;

/** Stored on every judge-scored row so a rubric edit invalidates old scores. */
export function rubricHash(): string {
  return createHash("sha256")
    .update(JSON.stringify(RUBRIC), "utf8")
    .digest("hex");
}

export function buildJudgePrompt(task: Task, candidate: string, reference: string): string {
  const anchors = Object.entries(RUBRIC.scale.anchors)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([k, v]) => `  ${k} = ${v}`)
    .join("\n");

  return [
    RUBRIC.instructions[0],
    "",
    "SCORING ANCHORS",
    anchors,
    "",
    "GUIDANCE",
    ...RUBRIC.guidance.map((g) => `  - ${g}`),
    "",
    `TASK (${task.id}, type ${task.type})`,
    task.instruction,
    "",
    `ORIGINAL BROKEN CODE (${task.input_file})`,
    "```python",
    task.code,
    "```",
    "",
    "REFERENCE FIX (ground truth for the stated requirements)",
    "```python",
    reference,
    "```",
    "",
    "CANDIDATE SOLUTION",
    "```python",
    candidate,
    "```",
  ].join("\n");
}

/** Judges return prose-ish model output; take the LAST SCORE: n, defensively. */
export function parseScore(text: string, min: number, max: number): number | null {
  const matches = [...text.matchAll(/SCORE\s*[:=]\s*(-?\d+(?:\.\d+)?)/gi)];
  const last = matches[matches.length - 1];
  if (!last) {
    const bare = text.match(/\b([1-5])\b/);
    return bare ? Number(bare[1]) : null;
  }
  const n = Math.round(Number(last[1]));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

export async function judge(task: Task, modelOutput: string): Promise<ScoreResult> {
  const reference = task.reference;
  if (!reference) {
    throw new Error(
      `task ${task.id} has scoring:"judge" but no "reference" field; ` +
        `the judge needs a ground-truth fix to grade against`
    );
  }

  const prompt = buildJudgePrompt(task, modelOutput, reference);
  const adapter = adapterFor(RUBRIC.judge_model);

  // gpt-oss is a reasoning model: its max_tokens must cover reasoning, or the
  // visible score never gets emitted. Same failure mode as Gemini.
  await acquire(adapter.provider, { cost: 1 });
  const res = await adapter.complete({
    modelVersion: RUBRIC.judge_model,
    system:
      "You are a strict, calibrated code reviewer. You reply with exactly one line: SCORE: <n>.",
    prompt,
    temperature: RUBRIC.judge_temperature,
    maxTokens: RUBRIC.max_output_tokens,
    seed: 0,
  });

  if (!res.text.trim()) {
    // Throwing beats scoring 0: a silent zero would look like a bad answer
    // rather than a broken judge, and would land in the DB as a real result.
    throw new Error(
      `judge (${RUBRIC.judge_model}) returned empty text for ${task.id}; ` +
        `max_tokens=${RUBRIC.max_output_tokens} was consumed by reasoning`
    );
  }

  const score = parseScore(res.text, RUBRIC.scale.min, RUBRIC.scale.max);
  if (score === null) {
    // An unparseable judge response is NOT a 1. Surface it instead of silently
    // scoring a valid answer as total failure.
    throw new Error(
      `judge returned unparseable score for ${task.id}: ${res.text.slice(0, 200)}`
    );
  }

  return {
    mode: "judge",
    passed: score >= 4,
    score,
    judge_model: RUBRIC.judge_model,
    rubric_hash: rubricHash(),
    raw_output: [
      `judge=${RUBRIC.judge_model}`,
      `score=${score}`,
      `raw=${res.text.slice(0, 2000)}`,
    ].join("\n"),
  };
}