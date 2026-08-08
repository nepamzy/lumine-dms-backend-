-- Sales Reps and Distributors previously had no street-address field at
-- all (only state/LGA) — this adds one, mandatory for those two roles at
-- signup, and visible to admin on their detail view.
ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;

-- Tracks how many times a Sales Rep or Distributor has been caught with
-- location access turned off after previously granting it. Reaching 5
-- auto-suspends the account (see auth.service.js registerLocationStrike).
ALTER TABLE users ADD COLUMN IF NOT EXISTS location_strikes INT NOT NULL DEFAULT 0;
