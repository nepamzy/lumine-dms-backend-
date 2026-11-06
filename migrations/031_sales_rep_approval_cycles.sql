-- Anchors each sales rep's Target Overview "month" to the day they were
-- approved, instead of the calendar month — a rep approved on the 15th
-- now has cycles that run 15th-to-14th, not 1st-to-end-of-month.
--
-- Backfill note: there's no historical record of the exact moment any
-- existing distributor/sales rep was approved (approval_status has never
-- been timestamped before this). created_at is the closest available
-- proxy — close for most, since approval often follows signup quickly,
-- but not exact for anyone approved well after they signed up. Going
-- forward (see approveDistributor in distributor.service.js, and the
-- auto-approval INSERT in auth.service.js), this is set to the real
-- approval moment.

ALTER TABLE distributors ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

UPDATE distributors
SET approved_at = created_at
WHERE approval_status = 'approved' AND approved_at IS NULL;
