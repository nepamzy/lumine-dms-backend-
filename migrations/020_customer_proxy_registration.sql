-- Lets a sales rep register a customer directly on the customer's behalf
-- (for people without an Android phone / who can't self-register). This
-- column distinguishes that path from a normal self-signup or a
-- referral-link signup, so admin can see which is which per sales rep.
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS registered_by_distributor_id UUID REFERENCES distributors(id);
