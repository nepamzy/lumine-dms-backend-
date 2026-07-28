-- Soft-delete for products, same pattern as migration 013 for users.
-- Needed because order_items.product_id / .batch_id have no ON DELETE
-- CASCADE, so a hard DELETE on any product that has ever been ordered
-- would fail outright (or, if forced, would corrupt historical order/
-- receipt data). Soft-deleting keeps every past order's product/batch
-- references intact while fully hiding the product from the live
-- catalog and admin product list.
ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_products_deleted_at ON products(deleted_at);
