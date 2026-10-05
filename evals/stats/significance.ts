/**
 * Significance testing. With 15 tasks, a raw pass-rate difference is noise; the
 * question is whether two models differ on the SAME tasks (paired data), which
 * is what McNemar's test answers.
 *
 * Pairing is at the task level: a task counts as passed for a model only if
 * every sample of it passed. Unpaired samples would inflate n and pretend to a
 * power the dataset does not have.
 */
import { taskMatrix } from "./bootstrap.ts";

export interface McNemarResult {
  a: string;
  b: string;
  n: number;
  bothPassed: number;
  aOnly: number;
  bOnly: number;
  neither: number;
  chiSquare: number;
  pValue: number;
  significant: boolean;
  /** which model won the discordant pairs */
  winner: string | null;
}

/** Chi-square survival function for 1 degree of freedom (closed form). */
export function chiSq1dfP(x: number): number {
  if (x <= 0) return 1;
  // P(X > x) for chi-square(1) = 2 * (1 - Phi(sqrt(x))) = erfc(sqrt(x/2))
  return erfc(Math.sqrt(x / 2));
}

/** Abramowitz & Stegun 7.1.26 — accurate to ~1.5e-7, plenty for a p-value. */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const y =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? y : 2 - y;
}

export function mcnemar(aPass: boolean[], bPass: boolean[], alpha = 0.05): McNemarResult {
  const n = Math.min(aPass.length, bPass.length);
  let bothPassed = 0;
  let aOnly = 0;
  let bOnly = 0;
  let neither = 0;
  for (let i = 0; i < n; i++) {
    const a = aPass[i]!;
    const b = bPass[i]!;
    if (a && b) bothPassed++;
    else if (a) aOnly++;
    else if (b) bOnly++;
    else neither++;
  }

  const discordant = aOnly + bOnly;
  // Continuity-corrected chi-square. With zero discordant pairs, p = 1 exactly.
  const chiSquare =
    discordant === 0 ? 0 : (Math.abs(aOnly - bOnly) - 1) ** 2 / discordant;
  const pValue = chiSquare <= 0 ? 1 : chiSq1dfP(chiSquare);

  return {
    a: "",
    b: "",
    n,
    bothPassed,
    aOnly,
    bOnly,
    neither,
    chiSquare,
    pValue,
    significant: pValue < alpha,
    winner: aOnly > bOnly ? "a" : bOnly > aOnly ? "b" : null,
  };
}

export async function compareModels(
  runId: string,
  modelA: string,
  modelB: string,
  alpha = 0.05
): Promise<McNemarResult> {
  const matrix = await taskMatrix(runId);
  const aPass = matrix.map((t) => t.passed[modelA] ?? false);
  const bPass = matrix.map((t) => t.passed[modelB] ?? false);
  const res = mcnemar(aPass, bPass, alpha);
  res.a = modelA;
  res.b = modelB;
  return res;
}

/** Tasks where the two models disagree — the interesting ones. */
export async function disagreementTasks(
  runId: string,
  modelA: string,
  modelB: string
): Promise<string[]> {
  const matrix = await taskMatrix(runId);
  return matrix
    .filter((t) => (t.passed[modelA] ?? false) !== (t.passed[modelB] ?? false))
    .map((t) => t.task_id);
}