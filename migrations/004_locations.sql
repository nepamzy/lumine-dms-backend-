-- GPS location on users (captured at registration)
ALTER TABLE users ADD COLUMN latitude NUMERIC(10,7);
ALTER TABLE users ADD COLUMN longitude NUMERIC(10,7);
ALTER TABLE users ADD COLUMN location_captured_at TIMESTAMP;

-- Snapshot of distributor's location each time they update an order status
CREATE TABLE order_location_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status VARCHAR(30) NOT NULL,
  latitude NUMERIC(10,7) NOT NULL,
  longitude NUMERIC(10,7) NOT NULL,
  recorded_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_location_updates_order ON order_location_updates(order_id);