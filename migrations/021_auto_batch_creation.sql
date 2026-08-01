-- Supports automated daily batch creation (500 packs/product/day):
--   - is_auto_generated marks batches created by the automated daily run,
--     as opposed to ones an admin added by hand via "Add Batch" — only
--     auto-generated batches get wiped/replaced by the next day's run.
--   - auto_batch_runs tracks each day the automation has fired, so the
--     "no." in the batch number keeps incrementing daily and the job is
--     safe to call more than once on the same day (idempotent).
ALTER TABLE product_batches ADD COLUMN IF NOT EXISTS is_auto_generated BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS auto_batch_runs (
  id SERIAL PRIMARY KEY,
  run_date DATE UNIQUE NOT NULL,
  sequence_no INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
