-- Defensive cleanup: customers should never be attached to a true
-- distributor (only to a sales rep). This fixes any existing rows that
-- were assigned before that rule was enforced in code — applies to
-- accounts that registered/were reassigned before this fix, not just new
-- signups going forward.
UPDATE customer_profiles cp
SET assigned_distributor_id = NULL
WHERE assigned_distributor_id IN (
  SELECT id FROM distributors WHERE distributor_type = 'distributor'
);

UPDATE customer_profiles cp
SET referred_by_distributor_id = NULL
WHERE referred_by_distributor_id IN (
  SELECT id FROM distributors WHERE distributor_type = 'distributor'
);
