# evalkit

A reproducible evaluation harness for code-editing models, built to run entirely
on free-tier provider quotas.

It answers one question honestly: **given a real task, does this model actually
fix it — and is the difference between two models real, or noise?** Every design
choice below serves that. Where the answer is "noise", the harness says so and
exits non-zero rather than printing a leaderboard.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Data model](#data-model)
- [Scoring modes](#scoring-modes)
- [Statistical method](#statistical-method)
- [Security model](#security-model)
- [Verification](#verification)
- [Measured results](#measured-results)
- [Operational notes](#operational-notes)
- [Known limitations](#known-limitations)
- [Project layout](#project-layout)

---

## Why this exists

Comparing two models by eyeballing their answers does not work. The failure modes
are specific:

| Failure | What it looks like | How evalkit prevents it |
|---|---|---|
| A model that got lucky | One good output, declared a winner | `sample_idx` is in the cache key; multiple samples per task |
| A flattering judge | Broken code wrapped in "I fixed this!" scores 5 | `check-judge.ts` asserts broken+prose scores ≤2 |
| Self-preferential judging | Model graded by its own family | Judge must differ in family from every subject |
| A task that is a free pass | Broken code already passes the tests | `check-dataset.ts` asserts broken code **fails** |
| An impossible task | Nothing passes; scored as "hard" | `check-dataset.ts` asserts the reference **passes** |
| Noise read as signal | 93% vs 87% declared a winner | McNemar + bootstrap CI; `--gate` exits 1 when insignificant |
| Silent rate-limit damage | Units marked failed that never ran | 429/503 retried inline, never counted as attempts |
| Stale model string | Every unit fails, run still "reports" | Live-call verification before registry changes |

Two of those (`broken+flattery`, `broken code already passes`) were found by
building the harness — the original dataset shipped with two tasks that were
already solved.

---

## How it works

```
    runUnit(unit)                        evals/runner/runUnit.ts
      │
      ├─ 1. cache lookup ──────────────► hit? reuse the response, never touch the provider
      │                                  miss ↓
      ├─ 2. token bucket ──────────────► Postgres token bucket, charged on miss only
      ├─ 3. adapter call ──────────────► groq.ts | google.ts
      ├─ 4. cache put
      ├─ 5. scorer ────────────────────► routes on task.scoring
      │                                    ├─ programmatic → sandbox → pytest → pass/fail
      │                                    └─ judge        → rubric → gpt-oss → 1..5
      ├─ 6. INSERT score row ───────────► ON CONFLICT DO NOTHING
      └─ 7. UPDATE unit state='done'
```

`runUnit` never decides pass/fail. It persists exactly what the scorer returned.
That separation is why the scorer is a real component with its own tests rather
than inline logic.

The queue is the `units` table itself — no Redis, no pg-boss:

```sql
UPDATE units SET state='running', attempts=attempts+1
 WHERE (run_id, task_id, model_version, sample_idx) = (
   SELECT ... FROM units WHERE state='pending'
    ORDER BY run_id, task_id
    FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;
```

`SKIP LOCKED` is what makes the worker safe to run twice: a second worker skips
locked rows instead of blocking or double-claiming.

---

## Architecture

Five components, each replaceable behind a narrow interface:

| Component | Interface | Responsibility |
|---|---|---|
| **Adapters** | `ModelAdapter` (`evals/adapters/types.ts`) | Pure HTTP shim. Model in, text + token counts out. No caching, no retries, no scoring. |
| **Limiter** | `acquire(provider, cost)` | Postgres token bucket. Knows nothing about models. |
| **Cache** | `cacheGet` / `cachePut` | Keyed by full request identity. Knows nothing about models. |
| **Scorer** | `Scorer` = `(task, output) => ScoreResult` | Decides pass/fail. Invokes the sandbox or a judge. |
| **Runner** | `runUnit(unit)` | Orchestration and persistence only. |

The dependency rule: **nothing below the runner knows a provider exists.**
Adapters are the only place a URL or an API key appears. This is what made it
possible to swap three dead models without touching the scorer, the cache, or
the worker.

```
   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │ Next.js  │   │  Worker  │   │ Scripts  │
   │ (read)   │   │ (write)  │   │          │
   └────┬─────┘   └────┬─────┘   └────┬─────┘
        │              │              │
        └──────────────┼──────────────┘
                       ▼
              ┌─────────────────┐
              │    Postgres     │
              │ runs units      │
              │ scores cache    │
              │ provider_limits │
              └────────┬────────┘
                       │
        ┌──────────────┴───────────────┐
        ▼                              ▼
  ┌───────────┐                 ┌──────────────┐
  │  Groq     │                 │  Google AI   │
  │  (HTTP)   │                 │  Studio      │
  └───────────┘                 └──────────────┘

  model output ──► ┌──────────────────────────┐
                   │ docker sandbox           │
                   │ --network=none           │
                   │ --read-only              │
                   │ /work mounted :ro        │
                   │ + 30s host-side kill     │
                   └──────────────────────────┘
```

The Next.js app is strictly read-only. It polls every 3s — no SSE, no websockets.

---

## Quick start

**Prerequisites:** Node 20+, Docker, a free [Groq](https://console.groq.com/keys)
key and a free [Google AI Studio](https://aistudio.google.com/apikey) key. No
credit card on either.

```bash
# 1. Database (host port 55432 — see note below)
docker compose up -d

# 2. Config
cp .env.example .env
$EDITOR .env          # add GROQ_API_KEY and GOOGLE_API_KEY

# 3. Dependencies
npm install

# 4. Schema (idempotent)
npm run migrate

# 5. Sandbox image — required before any scoring
npm run build-sandbox
```

Then run an evaluation:

```bash
npm run run-eval -- --models=qwen/qwen3.8-27b,gemini-3.5-flash-lite --samples=0,1,2
npm run report
```

And the dashboard, if you want to watch it live:

```bash
cd web && npm install && npx next dev -p 3000
```

**Port note:** Postgres defaults to host port **55432**, not 5432, because 5432 is
commonly occupied. Override with `POSTGRES_HOST_PORT`.

---

## Commands

| Command | Purpose |
|---|---|
| `npm run migrate` | Apply `db/schema.sql` (idempotent) |
| `npm run build-sandbox` | Build the locked-down pytest image |
| `npm run step1` | Single-unit proof: live call, cache miss → hit, one score row |
| `npm run step1 -- --offline` | Same proof with the network stubbed (no key needed) |
| `npm run step1 -- --fresh` | Truncate first, so run 1 is a genuine cache miss |
| `npm run run-eval` | Create a run and drive it to completion |
| `npm run worker` | Run the worker standalone against a run id |
| `npm run report` | Pass rates, bootstrap CIs, McNemar, per-task matrix |
| `npx tsx scripts/report.ts --latest --gate` | Exit 1 unless a difference is significant (CI) |
| `npm run check-dataset` | Assert every task is neither free nor impossible |
| `npm run check-scorer-negative` | Assert the scorer rejects known-broken code |
| `npm run check-sandbox` | Assert the sandbox's isolation boundaries hold |
| `npm run check-judge -- t06` | Assert the judge is calibrated (incl. flattery) |
| `npm run step8-judge -- t14` | Judge one task through the full `runUnit` chain |
| `npm run chaos` | `kill -9` the worker mid-run, prove no duplicates |

`run-eval` flags: `--models=a,b`, `--samples=0,1,2`, `--temperature`,
`--max-tokens`, `--dry-run`.

---

## Data model

Five tables, all in `db/schema.sql`.

```
runs          one evaluation. dataset_hash, token totals, wall-clock cap.
 │
 ├── units   THE QUEUE. one row per (task, model_version, sample_idx).
 │           state: pending -> running -> done | failed
 │
 ├── scores  the result. PK is the unit, so a re-score cannot duplicate.
 │           mode, passed, score, judge_model, rubric_hash, raw_output
 │
cache          response keyed by the full request identity (below)
provider_limits one token bucket per provider
```

**The cache key is the point of the whole schema:**

```
sha256(provider ‖ model_version ‖ sha(system) ‖ sha(prompt)
       ‖ params_hash ‖ sample_idx ‖ seed)
```

`sample_idx` is in the key deliberately. Leave it out and samples collide, you
silently lose variance, and your confidence intervals mean nothing. This was a
hard rule in the original spec and it is load-bearing, not ceremony.

Every write is `INSERT ... ON CONFLICT DO NOTHING`, which is what lets a killed
worker be restarted without cleanup.

---

## Scoring modes

`evals/scorer/index.ts` routes on `task.scoring`. Both modes are implemented.

### `programmatic` (default, primary signal)

The model's patch is written to a temp dir alongside the task's tests and
executed in the sandbox. `passed = exit code 0`.

Unarguable and reproducible. This is the signal to trust.

### `judge` (phase 2)

`openai/gpt-oss-120b` grades 1–5 against `rubric.json`, shown the original broken
code, the task instruction, and the task's hand-written `reference`.

Requires `task.reference`; `gen_tasks.py` refuses to emit a task without one.

Three deliberate properties:

- **Cross-family by construction.** The judge is a different model *family* from
  every subject. Subjects are Alibaba Qwen and Google Gemini, so the judge is
  OpenAI gpt-oss. A judge from the same family shares its blind spots, so a
  Qwen-graded-by-Qwen result is not evidence of anything.
- **It throws rather than guessing.** Empty or unparseable output raises an error
  instead of recording a 0, because a silent zero is indistinguishable from a
  genuinely bad answer once it is in the database.
- **It never sees which model produced the candidate.**

Exercise it without relabelling the dataset via `runUnit`'s `scoringOverride`:

```bash
npm run step8-judge -- t14        # judge one task end-to-end
npm run check-judge -- t06        # calibrate
```

---

## Statistical method

With 15 tasks, a raw pass-rate gap is noise until proven otherwise.

**Bootstrap CI** — percentile bootstrap over per-unit outcomes, 2000 resamples,
**seeded LCG**. Deterministic on purpose: a confidence interval that moves when
you re-read the page is useless as a gate.

**McNemar** — paired at the **task** level. A task counts as passed for a model
only if *every* sample passed. Pairing is what makes the test appropriate for
small, matched datasets; unpaired samples would inflate `n` and imply power the
dataset does not have. Continuity-corrected chi-square, with an exact `p = 1.0`
when there are zero discordant pairs.

`--gate` exits non-zero unless at least one pairwise comparison reaches p < 0.05,
so a CI pipeline cannot ship a leaderboard built on noise.

---

## Security model

Model output is untrusted code. It executes in exactly one place, under exactly
these constraints:

```
docker run --rm \
  --network=none                    no egress
  --read-only                       no filesystem writes
  --tmpfs /tmp:rw,size=64m          the only writable path, capped
  --memory 256m --pids-limit 64 --cpus 0.5 \
  --user 1000:1000                  never root
  -v <dir>:/work:ro -w /work         code and tests BOTH read-only
```

Plus a **30s host-side kill** (`reaper.ts`), because `--memory` and `--cpus` do
not stop a tight infinite loop.

The docker flags are only worth something if something tests them — a typo would
silently remove a boundary while every "verified" claim stayed green. So
`npm run check-sandbox` runs a probe *inside* the container:

| Probe | Required | Why it matters |
|---|---|---|
| Outbound network | blocked | no exfiltration, no fetching answers |
| Write to `/work` | blocked | **a model cannot rewrite the tests judging it** |
| Write to `/tmp` | allowed | intended, capped at 64m |
| `os.getuid()` | `1000` | never root |

```
PASS  no outbound network — blocked
PASS  tests are read-only (model cannot tamper) — blocked
PASS  tmpfs writable as intended — allowed
PASS  runs as non-root (uid 1000) — 1000
```

The container does read non-secret host files such as `/etc/hostname`; that is
normal for any container and is not a boundary this harness claims to enforce.

---

## Verification

Each script below is a claim about the system that fails loudly when untrue.

| Script | Asserts |
|---|---|
| `check-dataset` | Broken code **fails**; reference **passes**. Neither a free point nor impossible. |
| `check-scorer-negative` | The scorer rejects known-broken code (not rubber-stamping) |
| `check-sandbox` | Network blocked, `/work` read-only, non-root — run inside the container |
| `check-judge` | Reference ≥4, broken ≤2, **broken + flattering prose ≤2**; plus 9 parser cases |
| `step1` | Live call, cache miss → hit, no second provider call, exactly 1 score row |
| `step8-judge` | Judge works through the real `runUnit` chain; row has mode, judge_model, rubric_hash |
| `chaos` | After `kill -9`: 0 duplicate score rows, 0 stranded units, run reaches `complete` |

Last full run:

```
PASS  worker 1 was actually killed mid-run — stranded=1
PASS  no duplicate score rows — dupes=0
PASS  exactly one score row per unit — rows=15/15
PASS  no unit stuck in 'running' — {"done":15}
PASS  all units done — {"done":15}
PASS  run reached complete — complete
```

Judge calibration:

```
PASS  reference fix                 score=5 (want >=4)
PASS  original broken code          score=1 (want <=2)
PASS  broken code + flattering prose score=1 (want <=2)
```

---

## Measured results

15 tasks × 3 samples × 2 models = 90 units.

| model | pass rate | 95% CI |
|---|---|---|
| `gemini-3.5-flash-lite` | 42/45 (93.3%) | [84, 100]% |
| `qwen/qwen3.8-27b` | 39/45 (86.7%) | [76, 96]% |

**McNemar: p = 1.0000 — no significant difference.** The models disagree on
exactly one task (t14).

Read that as what it is: a 1-task difference is not evidence. The harness is
reporting the truth about a dataset that cannot separate these two models. See
[Known limitations](#known-limitations).

> Note: `--fresh` truncates the database. After running it, the tables contain
> only that single-unit proof, not the 90-unit run above. Re-run `run-eval` to
> reproduce.

---

## Operational notes

### Models

Registry keys are **exact** `model_version` strings — no fuzzy matching.

| `model_version` | provider | role |
|---|---|---|
| `qwen/qwen3.8-27b` | Groq | primary (Alibaba) |
| `gemini-3.5-flash-lite` | Google | baseline (Google) |
| `openai/gpt-oss-120b` | Groq | judge (OpenAI family) |

Four models named in the original spec are dead or unreachable:

- `qwen-2.5-coder-32b` — retired, off Groq's model list
- `gemini-2.0-flash` — shut down 2026-06-01
- `gemini-2.5-flash` — shut down for **new** API keys
- `llama-3.3-70b-versatile` — 404 "does not exist or you do not have access"

**Verify a model with a live call before adding it.** A dead model string fails
every unit rather than raising, and a run full of failures still reports numbers.

### Two independent rate limits per provider

They are enforced separately; throttling for one does not help the other.

- **Groq** — ~30 req/min (the token bucket handles this), *and* a per-request
  ceiling of ~1000 output tokens/min. A `max_tokens` above that returns 429 no
  matter how much bucket remains. Keep run `max_tokens` at ~512.
- **Google free tier** — a **daily** budget, **per model**, not per project. The
  429 body says `generate_content_free_tier_requests, limit: 20`. A per-minute
  bucket cannot protect a daily quota, so `limiter.ts` configures Google as
  capacity 3, refill 20/86400.

### Reasoning models return empty text on a tight budget

Gemini 3.x and gpt-oss spend part of the output budget thinking
(`thoughtsTokenCount` / `reasoning_tokens`). A budget sized for the visible
answer gets consumed by reasoning, and the response comes back **empty** with
`finishReason: MAX_TOKENS`. Measured: a 19-token Gemini answer cost ~165 thought
tokens.

Both adapters throw on empty rather than caching a blank — a cached empty string
would poison every later sample of that unit.

### Traps that cost real time here

- **Adapters must read `process.env` at call time**, and the header must use the
  resolved local — not `this.apiKey`. A constructor-injected key plus a header
  built from the field sends literal `Bearer undefined` → 401.
- **A fetch-level stub cannot catch auth bugs.** `--offline` replaces `fetch`, so
  it never inspects a malformed header. The step-1 offline proof passed green
  while the live call 401'd. Stubs and live calls test different things.
- **A 429 is not a unit failure.** It must not consume the attempt budget, or a
  quota window marks never-attempted units `failed`. The worker retries 429/503
  inline with `Retry-After` backoff while keeping the unit claimed.
- **dotenv never overrides an existing env var**, and an empty `KEY=` is not
  nullish — use `||=`, not `??=`.
- **Editing the dataset invalidates the cache.** `datasetHash()` feeds every
  cache key, so adding a field invalidates all of it and the next run re-spends
  quota from zero.

---

## Known limitations

Stated plainly, because a harness that oversells itself is worse than none.

1. **The dataset does not separate the two models.** They differ on one task;
   McNemar returns p = 1.0. More samples will not help — both models fail the same
   two tasks, so extra samples sharpen the *rates* but not the *difference*.
   Fixing this needs harder tasks or a third model.

2. **Dataset difficulty is calibrated by iteration, not design.** v1 was solved
   15/15; v2 was also solved 15/15; v3 finally left headroom. The current tasks
   are ~93% for both models — near ceiling, so there is little room to
   discriminate. Tasks that hard need more samples to reach a usable signal.

3. **No human calibration set.** The judge's 1–5 scale has not been checked
   against human labels, so its agreement with human judgement is unquantified.
   Judge scores are not yet trustworthy as a primary signal.

4. **Judge runs are not cached separately from model runs.** Judging the same
   unit twice re-spends a Groq call.

5. **`max_tokens` is tuned to these tasks** (~512). Larger patches would
   truncate; reasoning models need the multiplier in `google.ts`.

6. **Single worker by design.** `SKIP LOCKED` permits safe concurrency, but the
   harness is only *tested* with one process (chaos.ts restarts one).

---

## Project layout

```
db/schema.sql              5 tables, idempotent
db/migrate.ts              applies it

evals/adapters/
  types.ts                 EvalRequest, EvalResponse, ModelAdapter, AdapterError
  groq.ts                  api.groq.com (OpenAI-compatible)
  google.ts                generativelanguage.googleapis.com
  index.ts                 registry keyed by exact model_version
  README.md                how to add a provider

evals/sandbox/
  Dockerfile.python        python:3.11-slim + pytest, uid 1000
  run.ts                   the ONLY place model output executes
  reaper.ts                host-side 30s kill

evals/scorer/
  index.ts                 routes on task.scoring
  programmatic.ts          sandbox → pytest → pass/fail
  judge.ts                 rubric → cross-family grader → 1..5

evals/runner/
  cache.ts                 request-identity keying, ON CONFLICT DO NOTHING
  limiter.ts               Postgres token bucket, atomic UPDATE ... RETURNING
  worker.ts                ONE process, FOR UPDATE SKIP LOCKED
  runUnit.ts               the call chain
  createRun.ts             run + unit rows

evals/stats/
  bootstrap.ts             pass rate + seeded bootstrap CI
  significance.ts          McNemar, paired at task level

evals/datasets/codefix-v1/
  tasks.jsonl              15 tasks (generated)
  manifest.json            dataset metadata + system prompt
  manifest.ts              loader, datasetHash(), buildPrompt()
  rubric.json              judge anchors (phase 2)

scripts/
  gen_tasks.py             dataset source of truth, incl. REFERENCE_FIXES
  run-eval.ts              create a run and drive it
  report.ts                stats + significance gate
  chaos.ts                 kill -9 and prove recovery
  check-dataset.ts         no free points, no impossible tasks
  check-scorer-negative.ts scorer rejects broken code
  check-sandbox.ts         network blocked, /work read-only, non-root
  check-judge.ts           judge calibration
  step1-run-unit.ts        single-unit proof
  step8-judge-e2e.ts       judge through the full chain
  _stubAdapter.ts          --offline only

web/                       Next.js 14, read-only, 3s polling
  app/api/runs/route.ts
  app/api/runs/[id]/route.ts
  app/runs/[id]/page.tsx
  lib/stats.ts             read-side stats (mirrors evals/stats)
```

The Next.js app has its own `package.json` because the root package is the
worker/runtime and web needs a separate dependency tree (`next`, `react`).