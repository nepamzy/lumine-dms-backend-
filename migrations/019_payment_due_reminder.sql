-- Tracks the 2-week deadline given to a customer to finish paying off an
-- order when it arrives with less than 65% paid. Set once, the first time
-- any "received" box is ticked on a customer order below that threshold —
-- see confirmReceived() in order.service.js.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_due_at TIMESTAMPTZ;
