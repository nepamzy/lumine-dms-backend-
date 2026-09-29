-- Records what production couldn't actually fulfil on an order, after the
-- order's already been placed (and often already partly paid). Kept as its
-- own audit trail rather than silently rewriting order_items — order_items
-- + orders.total_amount remain the single source of truth for what's owed
-- (recordOrderShortfall in order.service.js reduces them directly, exactly
-- like editing the order), but this table is what lets the order detail
-- page show "originally ordered X, Y couldn't be produced, adjusted total
-- is Z" instead of just quietly changing the number.
CREATE TABLE order_shortfalls (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id      UUID NOT NULL REFERENCES orders(id),
    product_id    UUID NOT NULL REFERENCES products(id),
    variant_id    UUID NOT NULL REFERENCES product_variants(id),
    quantity      INTEGER NOT NULL CHECK (quantity > 0),
    unit_price    NUMERIC(12,2) NOT NULL,
    amount        NUMERIC(12,2) NOT NULL,
    note          TEXT,
    recorded_by   UUID NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_shortfalls_order ON order_shortfalls(order_id);
