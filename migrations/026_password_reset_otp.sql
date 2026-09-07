-- Forgot-password flow: a numeric OTP is emailed/texted to the user, then
-- verified against a bcrypt hash before a short-lived reset is allowed.
-- No new table — reset state is tied 1:1 to the requesting user, same as
-- how password_hash already lives directly on users.
ALTER TABLE users ADD COLUMN reset_otp_hash TEXT;
ALTER TABLE users ADD COLUMN reset_otp_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN reset_otp_attempts INTEGER NOT NULL DEFAULT 0;

-- Set once OTP verification succeeds and cleared the instant it's used to
-- actually reset the password — makes the short-lived reset token single-use
-- (its JWT signature alone only proves it was issued by us, not that it
-- hasn't already been redeemed).
ALTER TABLE users ADD COLUMN reset_session_id UUID;
