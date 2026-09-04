-- Target Overview: sales-rep monthly performance tracking.
--
-- paid_in_full_at: set once, the moment an order's successful payments
-- first reach its total_amount. Determines which month the order is
-- credited to in Target Overview -- NOT the month it was originally placed.
--
-- moved_to_target_overview_at: set by the monthly sweep (see
-- runMonthlyTargetSweep in order.service.js). While NULL, the order still
-- shows in the normal admin/sales-rep Orders tab regardless of payment
-- status. Once set, it's filtered out of those listings -- but NOT out of
-- getOrderById, so the customer who placed it keeps full access to it in
-- their own order history and can still download its receipt.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_in_full_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS moved_to_target_overview_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orders_paid_in_full_at ON orders(paid_in_full_at);
CREATE INDEX IF NOT EXISTS idx_orders_moved_to_target_overview_at ON orders(moved_to_target_overview_at);
