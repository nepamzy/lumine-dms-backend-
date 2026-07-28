-- Soft-delete for orders, same pattern as migrations 013 (users) and 017
-- (products). A hard DELETE on orders would fail the moment any payment
-- or delivery row exists for it (payments.order_id and deliveries.order_id
-- reference orders(id) with no ON DELETE CASCADE), and would destroy the
-- order's own financial/audit trail besides. Soft-deleting hides it from
-- every list while keeping it directly resolvable by ID if ever needed.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_orders_deleted_at ON orders(deleted_at);
