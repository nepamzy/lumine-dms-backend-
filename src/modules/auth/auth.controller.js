const asyncHandler = require("../../utils/asyncHandler");
const ApiError = require("../../utils/ApiError");
const authService = require("./auth.service");

// Deliberately its own flag, NOT tied to NODE_ENV — the local backend runs
// with NODE_ENV=production (required for the DB's SSL connection) even
// during local dev over plain http://localhost, where a `secure` cookie
// would be silently rejected by the browser. COOKIE_SECURE is set true only
// on the actual deployed (HTTPS) server.
const cookieSecure = process.env.COOKIE_SECURE === "true";

function setRefreshCookie(res, token) {
  res.cookie("refreshToken", token, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: cookieSecure ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

const registerHandler = asyncHandler(async (req, res) => {
  const { fullName, email, phone, password, role, state, latitude, longitude, localGovernment, ...extra } = req.body;
  // Email is optional for customers — phone (required, unique — see
  // migration 001/013) works as their login identifier too (auth.service's
  // login() matches either column). Distributors and sales reps still need
  // an email: it's how they're found/contacted for approval and business
  // correspondence.
  if (!fullName || !phone || !password || !role || !state || (role !== "customer" && !email)) {
    throw new ApiError(400, "Missing required fields");
  }
  if (password.length < 8) {
    throw new ApiError(400, "Password must be at least 8 characters");
  }
  const user = await authService.register({
    fullName,
    email,
    phone,
    password,
    role,
    state,
    latitude,
    longitude,
    localGovernment,
    extra,
  });

  res.status(201).json({
    success: true,
    message:
      role === "distributor"
        ? "Account created. Awaiting admin approval before you can sign in."
        : "Account created successfully.",
    data: user,
  });
});

const loginHandler = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    throw new ApiError(400, "Email/phone and password are required");
  }

  const { user, accessToken, refreshToken } = await authService.login({
    email,
    password,
  });
  setRefreshCookie(res, refreshToken);

  res.json({ success: true, data: { user, accessToken } });
});

const refreshHandler = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.refreshToken || req.body.refreshToken;
  const { accessToken } = await authService.refresh(refreshToken);
  res.json({ success: true, data: { accessToken } });
});

const logoutHandler = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.refreshToken || req.body.refreshToken;
  await authService.logout(refreshToken);
  res.clearCookie("refreshToken");
  res.json({ success: true, message: "Logged out" });
});

const meHandler = asyncHandler(async (req, res) => {
  const user = await authService.getCurrentUser(req.user.id);
  res.json({ success: true, data: user });
});

const updateProfileHandler = asyncHandler(async (req, res) => {
  const user = await authService.updateProfile(req.user.id, req.body);
  res.json({ success: true, data: user });
});

const changePasswordHandler = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    throw new ApiError(400, "Current and new password are required");
  }
  await authService.changePassword(req.user.id, currentPassword, newPassword);
  res.json({ success: true, message: "Password changed successfully" });
});
const forgotPasswordHandler = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) throw new ApiError(400, "Email or phone is required");
  await authService.forgotPassword(email);
  res.json({ success: true, message: "If an account exists for that email or phone, a reset code has been sent." });
});

const verifyResetOtpHandler = asyncHandler(async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) throw new ApiError(400, "Email/phone and code are required");
  const resetToken = await authService.verifyResetOtp(email, code);
  res.json({ success: true, data: { resetToken } });
});

const resetPasswordHandler = asyncHandler(async (req, res) => {
  const { resetToken, newPassword } = req.body;
  if (!resetToken || !newPassword) throw new ApiError(400, "Reset token and new password are required");
  const { user, accessToken, refreshToken } = await authService.resetPassword(resetToken, newPassword);
  setRefreshCookie(res, refreshToken);
  res.json({ success: true, data: { user, accessToken } });
});

const acknowledgePaymentNoticeHandler = asyncHandler(async (req, res) => {
  await authService.acknowledgePaymentNotice(req.user.id);
  res.json({ success: true, message: "Acknowledged" });
});

const updateLocationHandler = asyncHandler(async (req, res) => {
  const { latitude, longitude } = req.body;
  const user = await authService.updateLocation(req.user.id, { latitude, longitude });
  res.json({ success: true, data: user });
});

module.exports = {
  registerHandler,
  loginHandler,
  refreshHandler,
  logoutHandler,
  meHandler,
  updateProfileHandler,
  changePasswordHandler,
  acknowledgePaymentNoticeHandler,
  updateLocationHandler,
  forgotPasswordHandler,
  verifyResetOtpHandler,
  resetPasswordHandler,
};