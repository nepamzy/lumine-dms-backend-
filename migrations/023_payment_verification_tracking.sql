-- Supports the payment-verification rework: instead of a single Paystack
-- check that permanently marks a payment "failed" the moment it isn't an
-- instant "success", we now retry and, if still inconclusive, leave it
-- "pending" and keep re-checking it. These columns let us see when a
-- payment was last checked and how many times, both for the reconciliation
-- job (so it doesn't hammer Paystack) and for support/debugging.
ALTER TABLE order_payments ADD COLUMN last_checked_at TIMESTAMPTZ;
ALTER TABLE order_payments ADD COLUMN check_attempts INTEGER NOT NULL DEFAULT 0;
