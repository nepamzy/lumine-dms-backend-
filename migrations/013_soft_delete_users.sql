-- Soft-delete system: admin can remove a customer/distributor/sales rep.
-- Their records are hidden everywhere EXCEPT a dedicated admin "Trash"
-- view — nothing is actually destroyed. The same email/phone can then be
-- used to register a brand new account, with no history carried over on
-- the person's own side. If admin sees a newly (re-)registered account
-- that shares an email with a soft-deleted one, it's flagged "User (2)"
-- on the admin side only.
ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;

-- Drop the old plain-unique constraints (Postgres's default auto-generated
-- names for inline UNIQUE columns) and replace with partial unique indexes
-- that only apply to ACTIVE (not soft-deleted) accounts — this is what
-- allows the same email/phone to be reused after a removal.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_key;
CREATE UNIQUE INDEX idx_users_email_active ON users(email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_users_phone_active ON users(phone) WHERE deleted_at IS NULL;

CREATE INDEX idx_users_deleted_at ON users(deleted_at);
