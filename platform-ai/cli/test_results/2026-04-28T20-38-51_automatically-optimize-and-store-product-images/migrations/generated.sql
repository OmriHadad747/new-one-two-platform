CREATE TABLE optimization_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton = true),
  schedule_frequency TEXT NOT NULL DEFAULT 'daily' CHECK (schedule_frequency IN ('daily', 'weekly', 'custom')),
  schedule_hour_utc INTEGER NOT NULL DEFAULT 2,
  schedule_day_of_week INTEGER NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE optimization_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'manual')),
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'failed')),
  total_images INTEGER NOT NULL DEFAULT 0,
  succeeded_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_optimization_runs_status ON optimization_runs (status);
CREATE INDEX idx_optimization_runs_started_at ON optimization_runs (started_at);

CREATE TABLE optimization_run_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES optimization_runs(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL,
  product_title TEXT NOT NULL,
  image_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_width INTEGER NULL,
  source_height INTEGER NULL,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'succeeded', 'skipped', 'failed')),
  failure_reason TEXT NULL,
  optimized_url TEXT NULL,
  processed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_optimization_run_items_run_id ON optimization_run_items (run_id);
CREATE INDEX idx_optimization_run_items_outcome ON optimization_run_items (outcome);
CREATE INDEX idx_optimization_run_items_product_id ON optimization_run_items (product_id);