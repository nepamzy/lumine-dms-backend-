-- Per-order expiry tracking, separate from product_batches.expiry_date
-- (which stays as-is for live inventory/FEFO). This is set automatically
-- the moment an order is confirmed "on transport": expiry_date = that
-- moment + 50 days. It's what powers the countdown badges/popups shown to
-- admin, customers, distributors, and sales reps.
ALTER TABLE orders ADD COLUMN expiry_date TIMESTAMPTZ;
CREATE INDEX idx_orders_expiry ON orders(expiry_date);
