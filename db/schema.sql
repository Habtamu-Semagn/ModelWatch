CREATE TABLE IF NOT EXISTS runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state              text NOT NULL DEFAULT 'running',
  dataset_hash       text NOT NULL,
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  max_duration_ms    int NOT NULL DEFAULT 3600000,
  total_input_tokens int NOT NULL DEFAULT 0,
  total_output_tokens int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS units (
  run_id        uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id       text NOT NULL,
  model_version text NOT NULL,
  sample_idx    int  NOT NULL,
  state         text NOT NULL DEFAULT 'pending',
  attempts      int  NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, task_id, model_version, sample_idx)
);
CREATE INDEX IF NOT EXISTS units_pending_idx ON units (run_id) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS scores (
  run_id        uuid NOT NULL,
  task_id       text NOT NULL,
  model_version text NOT NULL,
  sample_idx    int  NOT NULL,
  mode          text NOT NULL,
  passed        boolean NOT NULL,
  score         numeric,
  judge_model   text,
  rubric_hash   text,
  temperature   numeric,
  seed          int,
  raw_output    text,
  PRIMARY KEY (run_id, task_id, model_version, sample_idx)
);

CREATE TABLE IF NOT EXISTS cache (
  cache_key         text PRIMARY KEY,
  provider          text NOT NULL,
  model_version     text NOT NULL,
  system_prompt_hash text NOT NULL,
  prompt_hash       text NOT NULL,
  params_hash       text NOT NULL,
  sample_idx        int NOT NULL,
  seed              int,
  response          text NOT NULL,
  input_tokens      int NOT NULL DEFAULT 0,
  output_tokens     int NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_limits (
  provider       text PRIMARY KEY,
  capacity       numeric NOT NULL,
  refill_per_sec numeric NOT NULL,
  tokens         numeric NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);