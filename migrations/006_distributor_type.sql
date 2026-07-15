-- Splits the existing "distributor" concept into two behavioral types
-- without touching the underlying table/relationships (orders.distributor_id,
-- deliveries.distributor_id, customer_profiles.assigned_distributor_id, etc.
-- all keep working unchanged — this is purely a type flag).
--
-- 'sales_rep'   = today's existing distributors, renamed in the UI to
--                 "Sales Rep". No discount pricing on their own orders.
--                 Manages a book of attached customers (full detail view).
-- 'distributor' = the new role. Has discount pricing + a cart like a
--                 customer. Can refer other distributors, but only sees a
--                 headcount, not a managed customer list.
--
-- Every existing row defaults to 'sales_rep' — that's correct, since
-- everything that exists today in this table IS what becomes Sales Rep.
ALTER TABLE distributors
  ADD COLUMN distributor_type VARCHAR(20) NOT NULL DEFAULT 'sales_rep'
  CHECK (distributor_type IN ('sales_rep', 'distributor'));

CREATE INDEX idx_distributors_type ON distributors(distributor_type);
