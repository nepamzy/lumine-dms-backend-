const asyncHandler = require("../../utils/asyncHandler");
const ApiError = require("../../utils/ApiError");
const authService = require("./auth.service");

const isProd = process.env.NODE_ENV === "production";

function setRefreshCookie(res, token) {
  res.cookie("refreshToken", token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

const registerHandler = asyncHandler(async (req, res) => {
  const { fullName, email, phone, password, role, state, latitude, longitude, ...extra } = req.body;
  if (!fullName || !email || !phone || !password || !role || !state) {
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
    throw new ApiError(400, "Email and password are required");
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

module.exports = {
  registerHandler,
  loginHandler,
  refreshHandler,
  logoutHandler,
  meHandler,
};
