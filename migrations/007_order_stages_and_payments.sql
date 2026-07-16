-- Order stage tracking. "Placed" and "in production" are derived, not
-- stored: placed = the order exists (created_at), in production = 48 hours
-- have passed since created_at, regardless of payment. Only the manual
-- stages need columns:
ALTER TABLE orders ADD COLUMN placed_by_user_id UUID REFERENCES users(id);
-- Who actually clicked "place order" — usually the buyer themselves, but for
-- a customer order placed by their sales rep on the customer's behalf, this
-- is the sales rep's user id while customer_id stays the customer who owns
-- and pays for the order.

ALTER TABLE orders ADD COLUMN transport_confirmed_at TIMESTAMPTZ;
-- Admin-only manual tick: order moved to "on transport."

ALTER TABLE orders ADD COLUMN received_confirmed_admin_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN received_confirmed_staff_at TIMESTAMPTZ;
-- "staff" = the sales rep, for customer orders only. Stays null for a
-- distributor's own order (that order type only has admin + buyer).
ALTER TABLE orders ADD COLUMN received_confirmed_buyer_at TIMESTAMPTZ;
-- The customer's own tick (customer orders) or the distributor's own tick
-- (distributor orders) — whoever owns customer_id on this order.

-- Who ticked each received-confirmation box, so the UI can show e.g. "ticked
-- by admin on behalf of the distributor" rather than implying the
-- distributor did it themselves.
ALTER TABLE orders ADD COLUMN received_confirmed_staff_by UUID REFERENCES users(id);
ALTER TABLE orders ADD COLUMN received_confirmed_buyer_by UUID REFERENCES users(id);

-- Payment history — a running log, not a single overwritable number. Percent
-- paid on an order is always SUM(order_payments.amount) / orders.total_amount.
CREATE TABLE order_payments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    recorded_by   UUID NOT NULL REFERENCES users(id),
    note          VARCHAR(255),
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_payments_order ON order_payments(order_id);

-- One-time acknowledgment that all payment happens on-platform, shown to a
-- customer before their first order.
ALTER TABLE customer_profiles ADD COLUMN acknowledged_payment_notice BOOLEAN NOT NULL DEFAULT false;
