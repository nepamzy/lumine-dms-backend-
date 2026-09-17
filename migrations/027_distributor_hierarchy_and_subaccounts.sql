-- Tracks which TRUE distributor onboarded a given sales rep (mirrors
-- customer_profiles.registered_by_distributor_id). NULL = self-registered
-- or admin-created, same as every sales rep today.
ALTER TABLE distributors ADD COLUMN registered_by_distributor_id UUID REFERENCES distributors(id);

-- Paystack subaccount, once verified + created via the distributor's own
-- dashboard. account_name is the name Paystack itself resolved for the
-- entered account number — stored for display/audit, not re-fetched on
-- every read.
ALTER TABLE distributors ADD COLUMN paystack_subaccount_code VARCHAR(50);
ALTER TABLE distributors ADD COLUMN paystack_settlement_bank VARCHAR(10);
ALTER TABLE distributors ADD COLUMN paystack_account_number VARCHAR(20);
ALTER TABLE distributors ADD COLUMN paystack_account_name VARCHAR(150);

-- Which TRUE distributor (if any) this order's buyer chain ultimately
-- belongs to — set once at order-creation time, same philosophy as the
-- existing orders.distributor_id / Target Overview attribution (a later
-- reassignment doesn't retroactively reclassify old orders). NULL means
-- "Normal Order": a distributor buying directly, or a customer/sales rep
-- with no distributor anywhere in their registration chain.
ALTER TABLE orders ADD COLUMN registered_under_distributor_id UUID REFERENCES distributors(id);
CREATE INDEX idx_orders_registered_under_distributor ON orders(registered_under_distributor_id);
