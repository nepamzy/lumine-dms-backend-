-- LGA (Local Government Area) field, on top of existing state field, for both
-- customers and distributors (both live in `users`). Lets us match a customer
-- to the closest distributor at a finer granularity than state alone.
ALTER TABLE users ADD COLUMN local_government VARCHAR(100);
CREATE INDEX idx_users_lga ON users(local_government);
CREATE INDEX idx_users_state_lga ON users(state, local_government);

-- Each distributor gets a unique referral code, used to build their personal
-- signup link (…/register?ref=CODE). Customers who sign up through it are
-- auto-assigned to that distributor.
ALTER TABLE distributors ADD COLUMN referral_code VARCHAR(20) UNIQUE;

-- assigned_distributor_id: the distributor CURRENTLY responsible for this
-- customer. Admin can change this any time (e.g. reassigning for efficiency).
-- referred_by_distributor_id: the distributor whose referral link the
-- customer originally signed up through, if any. This never changes — it's
-- kept for referral-tracking/incentive purposes even after a reassignment.
ALTER TABLE customer_profiles ADD COLUMN assigned_distributor_id UUID REFERENCES distributors(id);
ALTER TABLE customer_profiles ADD COLUMN referred_by_distributor_id UUID REFERENCES distributors(id);
CREATE INDEX idx_customer_profiles_assigned ON customer_profiles(assigned_distributor_id);
CREATE INDEX idx_customer_profiles_referred_by ON customer_profiles(referred_by_distributor_id);
