/**
 * THE call chain. One unit, fixed order:
 *   1. cache lookup
 *   2. (miss) token bucket          <- step 4
 *   3. adapter call
 *   4. cache put
 *   5. scorer (routes by task.scoring)
 *   6. INSERT score row ON CONFLICT DO NOTHING
 *   7. UPDATE unit state='done'
 *
 * runUnit never decides pass/fail. It persists what the scorer returned.
 */
import { adapterFor } from "../adapters/index.ts";
import { taskById, buildPrompt, SYSTEM_PROMPT } from "../datasets/codefix-v1/manifest.ts";
import { scorerFor } from "../scorer/index.ts";
import { cacheGet, cacheKey, cachePut, paramsHash, pool } from "./cache.ts";
import { acquire } from "./limiter.ts";

export interface UnitRow {
  run_id: string;
  task_id: string;
  model_version: string;
  sample_idx: number;
}

export interface RunUnitOptions {
  temperature: number;
  maxTokens: number;
  seedBase?: number;
  /**
   * Score with a mode other than task.scoring. Used to exercise judge scoring
   * against the programmatic dataset without relabelling the tasks themselves —
   * a task's declared scoring mode is data, not a switch.
   */
  scoringOverride?: "programmatic" | "judge";
}

export interface RunUnitOutcome {
  unit: UnitRow;
  cacheHit: boolean;
  output: string;
  inputTokens: number;
  outputTokens: number;
  score: { mode: string; passed: boolean; score: number | null };
  persisted: boolean;
}

export async function runUnit(
  unit: UnitRow,
  opts: RunUnitOptions
): Promise<RunUnitOutcome> {
  const task = taskById(unit.task_id);
  const seed = (opts.seedBase ?? 0) + unit.sample_idx;
  const prompt = buildPrompt(task);
  const adapter = adapterFor(unit.model_version);
  const key = cacheKey({
    provider: adapter.provider,
    modelVersion: unit.model_version,
    system: SYSTEM_PROMPT,
    prompt,
    paramsHash: paramsHash({ temperature: opts.temperature, maxTokens: opts.maxTokens }),
    sampleIdx: unit.sample_idx,
    seed,
  });

  // 1. cache lookup
  let text: string;
  let inputTokens: number;
  let outputTokens: number;
  let cacheHit = true;
  const hit = await cacheGet(key);

  if (hit) {
    ({ response: text, input_tokens: inputTokens, output_tokens: outputTokens } = hit);
  } else {
    cacheHit = false;
    // 2. token bucket — free tiers hard-rate-limit, so this is required.
    //    Charged on cache MISS only; a hit never touches the provider.
    await acquire(adapter.provider, { cost: 1 });
    // 3. adapter call
    const res = await adapter.complete({
      modelVersion: unit.model_version,
      system: SYSTEM_PROMPT,
      prompt,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      seed,
    });
    text = res.text;
    inputTokens = res.inputTokens;
    outputTokens = res.outputTokens;
    // 4. cache put
    await cachePut(
      key,
      { provider: adapter.provider, modelVersion: unit.model_version, system: SYSTEM_PROMPT,
        prompt, paramsHash: paramsHash({ temperature: opts.temperature, maxTokens: opts.maxTokens }),
        sampleIdx: unit.sample_idx, seed },
      { response: text, input_tokens: inputTokens, output_tokens: outputTokens }
    );
  }

  // 5. scorer (a real component, not inline logic)
  const scoredTask =
    opts.scoringOverride && opts.scoringOverride !== task.scoring
      ? { ...task, scoring: opts.scoringOverride }
      : task;
  const result = await scorerFor(scoredTask)(scoredTask, text);

  // 6. INSERT score row, ON CONFLICT DO NOTHING
  const ins = await pool.query(
    `INSERT INTO scores (run_id, task_id, model_version, sample_idx, mode, passed, score,
                         judge_model, rubric_hash, temperature, seed, raw_output)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (run_id, task_id, model_version, sample_idx) DO NOTHING`,
    [unit.run_id, unit.task_id, unit.model_version, unit.sample_idx, result.mode,
     result.passed, result.score, result.judge_model, result.rubric_hash,
     opts.temperature, seed, result.raw_output]
  );

  // 7. unit done
  await pool.query(
    `UPDATE units SET state = 'done'
      WHERE run_id=$1 AND task_id=$2 AND model_version=$3 AND sample_idx=$4`,
    [unit.run_id, unit.task_id, unit.model_version, unit.sample_idx]
  );

  await pool.query(
    `UPDATE runs
        SET total_input_tokens = total_input_tokens + $2,
            total_output_tokens = total_output_tokens + $3
      WHERE id = $1`,
    [unit.run_id, inputTokens, outputTokens]
  );

  return {
    unit,
    cacheHit,
    output: text,
    inputTokens,
    outputTokens,
    score: { mode: result.mode, passed: result.passed, score: result.score },
    persisted: ins.rowCount === 1,
  };
}