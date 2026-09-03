-- Email is now optional, but ONLY in practice for customers a sales rep
-- registers on their behalf (registerCustomerForRep) — normal self-signup
-- still requires it at the controller level (auth.controller.js). The
-- partial unique index from migration 013 (idx_users_email_active) already
-- only applies to non-deleted rows, and Postgres unique indexes already
-- treat multiple NULLs as distinct, so no index change is needed here —
-- just drop the NOT NULL.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
