-- Ties each payment log entry to a real Paystack transaction. Existing rows
-- (manually logged during earlier testing) default to 'successful' so they
-- remain valid; every new payment going forward is created 'pending' and
-- only flips to 'successful' once Paystack actually confirms the money
-- landed — never just because the buyer typed a number.
ALTER TABLE order_payments ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'successful'
  CHECK (status IN ('pending', 'successful', 'failed'));
ALTER TABLE order_payments ADD COLUMN paystack_reference VARCHAR(100) UNIQUE;
CREATE INDEX idx_order_payments_reference ON order_payments(paystack_reference);
