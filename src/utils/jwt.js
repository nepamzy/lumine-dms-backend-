const jwt = require("jsonwebtoken");

function signAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_ACCESS_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
  });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_ACCESS_SECRET);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
}

// Proves a user completed OTP verification during the forgot-password flow,
// without being a real login token — reuses JWT_ACCESS_SECRET (no new env
// var needed) but is distinguished by its own purpose claim, checked on
// verify so it can never be accepted anywhere an access token is expected.
function signPasswordResetToken(payload) {
  return jwt.sign({ ...payload, purpose: "password_reset" }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: "15m",
  });
}

function verifyPasswordResetToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
  if (decoded.purpose !== "password_reset") {
    throw new Error("Not a password reset token");
  }
  return decoded;
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  signPasswordResetToken,
  verifyPasswordResetToken,
};
